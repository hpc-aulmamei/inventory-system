"""Optional LDAP (for example FreeIPA) login for administrators.

LDAP login is disabled unless LDAP_SERVER_URI is set. A user is authenticated
by binding as their own DN, built from LDAP_USER_DN_TEMPLATE, and is allowed in
only when they belong to LDAP_REQUIRED_GROUP_DN. The password is never stored.
"""

import logging
import os
import re
import ssl
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

from ldap3 import BASE, LEVEL, NONE, SYNC, Connection, Server, Tls
from ldap3.core.exceptions import LDAPException
from ldap3.utils.conv import escape_filter_chars
from ldap3.utils.dn import escape_rdn

logger = logging.getLogger(__name__)

# FreeIPA/POSIX-style login names. Anything else is rejected before contacting
# the directory, which also keeps DN and filter construction unambiguous.
USERNAME_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
CLIENT_STRATEGY = SYNC


class LdapLoginError(Exception):
    """Base class for LDAP login failures."""


class LdapUnavailable(LdapLoginError):
    """The directory is unreachable or LDAP login is misconfigured."""


class LdapInvalidCredentials(LdapLoginError):
    """The directory rejected the username or password."""


class LdapNotAuthorized(LdapLoginError):
    """Valid directory account, but not a member of the required group."""


@dataclass(frozen=True)
class LdapConfig:
    host: str
    port: int
    use_ssl: bool
    start_tls: bool
    user_dn_template: str
    required_group_dn: str
    ca_certs_file: str | None
    timeout: int


@dataclass(frozen=True)
class LdapUser:
    username: str
    display_name: str


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def ldap_enabled() -> bool:
    return bool(os.getenv("LDAP_SERVER_URI", "").strip())


def config_fingerprint() -> str | None:
    """Identify the configuration an LDAP session was issued under."""
    if not ldap_enabled():
        return None
    return "\0".join(os.getenv(name, "").strip() for name in (
        "LDAP_SERVER_URI", "LDAP_START_TLS", "LDAP_USER_DN_TEMPLATE",
        "LDAP_REQUIRED_GROUP_DN", "LDAP_CA_CERT_FILE",
    ))


def load_config() -> LdapConfig:
    uri = os.getenv("LDAP_SERVER_URI", "").strip()
    try:
        parsed = urlparse(uri)
        port = parsed.port
    except ValueError:
        raise LdapUnavailable("LDAP_SERVER_URI is not a valid URL") from None
    if parsed.scheme not in {"ldap", "ldaps"} or not parsed.hostname:
        raise LdapUnavailable("LDAP_SERVER_URI must be ldaps://host[:port] or ldap://host[:port]")
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment or parsed.username or parsed.password:
        raise LdapUnavailable("LDAP_SERVER_URI must not contain a path, query or credentials")

    use_ssl = parsed.scheme == "ldaps"
    start_tls = _env_bool("LDAP_START_TLS")
    if use_ssl and start_tls:
        raise LdapUnavailable("Use either ldaps:// or LDAP_START_TLS, not both")
    if not use_ssl and not start_tls:
        # Simple bind sends the password as-is; never do that in cleartext.
        raise LdapUnavailable("ldap:// requires LDAP_START_TLS=true; prefer ldaps://")

    template = os.getenv("LDAP_USER_DN_TEMPLATE", "").strip()
    try:
        valid_template = template.count("{username}") == 1 and template.format(username="x")
    except (KeyError, IndexError, ValueError):
        valid_template = False
    if not valid_template:
        raise LdapUnavailable("LDAP_USER_DN_TEMPLATE must contain {username} exactly once")

    # Without a group every directory account would become an administrator.
    group = os.getenv("LDAP_REQUIRED_GROUP_DN", "").strip()
    if not group:
        raise LdapUnavailable("LDAP_REQUIRED_GROUP_DN is required")

    ca_certs_file = os.getenv("LDAP_CA_CERT_FILE", "").strip() or None
    if ca_certs_file and not Path(ca_certs_file).is_file():
        raise LdapUnavailable("LDAP_CA_CERT_FILE does not exist")

    try:
        timeout = min(60, max(1, int(os.getenv("LDAP_TIMEOUT_SECONDS", "5"))))
    except ValueError:
        timeout = 5

    return LdapConfig(
        host=parsed.hostname,
        port=port or (636 if use_ssl else 389),
        use_ssl=use_ssl,
        start_tls=start_tls,
        user_dn_template=template,
        required_group_dn=group,
        ca_certs_file=ca_certs_file,
        timeout=timeout,
    )


def _server(config: LdapConfig) -> Server:
    # ldap3 defaults to CERT_NONE; certificate and hostname checks are explicit.
    tls = Tls(validate=ssl.CERT_REQUIRED, ca_certs_file=config.ca_certs_file, sni=config.host)
    return Server(
        config.host,
        port=config.port,
        use_ssl=config.use_ssl,
        tls=tls,
        connect_timeout=config.timeout,
        get_info=NONE,
    )


def _normalize_dn(dn: str) -> str:
    return re.sub(r"\s*([,=+])\s*", r"\1", dn.strip()).lower()


def _first(entry: dict, name: str) -> str | None:
    values = entry.get(name) or []
    if isinstance(values, str):
        return values
    return str(values[0]) if values else None


def _search_one(connection: Connection, base: str, search_filter: str, attributes: list[str]) -> dict | None:
    if not connection.search(base, search_filter, search_scope=BASE, attributes=attributes):
        return None
    for item in connection.response or []:
        if item.get("type") == "searchResEntry":
            return item.get("attributes") or {}
    return None


@contextmanager
def _bound_connection(config: LdapConfig, username: str, password: str) -> Iterator[tuple[Connection, str]]:
    """Open a verified TLS connection and bind as the given directory user."""
    if not password or not USERNAME_PATTERN.fullmatch(username):
        raise LdapInvalidCredentials()

    user_dn = config.user_dn_template.format(username=escape_rdn(username))
    connection = None
    try:
        connection = Connection(
            _server(config),
            user=user_dn,
            password=password,
            client_strategy=CLIENT_STRATEGY,
            receive_timeout=config.timeout,
            read_only=True,
            raise_exceptions=False,
        )
        connection.open()
        if config.start_tls and not connection.start_tls():
            raise LdapUnavailable("StartTLS failed")
        if not connection.bind():
            # The server answered and refused the credentials (wrong password,
            # unknown or locked account). Details stay in the server log.
            logger.info("LDAP bind refused for %s: %s", username, connection.result.get("description"))
            raise LdapInvalidCredentials()
        yield connection, user_dn
    except LDAPException as exc:
        logger.warning("LDAP server %s is unavailable: %s", config.host, exc)
        raise LdapUnavailable("LDAP server is unavailable") from exc
    finally:
        if connection is not None:
            try:
                connection.unbind()
            except LDAPException:
                pass


def authenticate(username: str, password: str) -> LdapUser:
    config = load_config()
    with _bound_connection(config, username, password) as (connection, user_dn):
        entry = _search_one(connection, user_dn, "(objectClass=*)", ["cn", "displayName", "memberOf"]) or {}
        group = _normalize_dn(config.required_group_dn)
        member_of = {_normalize_dn(str(dn)) for dn in entry.get("memberOf") or []}
        if group not in member_of:
            # memberOf may be absent (plain OpenLDAP); ask the group itself.
            member_filter = "(|(member={0})(uniqueMember={0})(memberUid={1}))".format(
                escape_filter_chars(user_dn), escape_filter_chars(username),
            )
            if _search_one(connection, config.required_group_dn, member_filter, ["cn"]) is None:
                raise LdapNotAuthorized()

        return LdapUser(
            username=username,
            display_name=_first(entry, "displayName") or _first(entry, "cn") or username,
        )


@dataclass(frozen=True)
class DirectoryPerson:
    uid: str
    name: str
    email: str | None
    phone: str | None
    responsible: bool


@dataclass(frozen=True)
class DirectorySnapshot:
    people: list[DirectoryPerson]
    # None: no responsible group configured, so roles are left as they are.
    responsible_group: str | None
    responsible_group_found: bool


# FreeIPA's built-in administrator is an account, not a person who borrows.
NON_PERSON_ACCOUNTS = {"admin"}
_PAGED_RESULTS = "1.2.840.113556.1.4.319"


def _search_all(connection: Connection, base: str, search_filter: str, attributes: list[str]) -> list[dict]:
    entries, cookie = [], None
    while True:
        connection.search(base, search_filter, search_scope=LEVEL, attributes=attributes,
                          paged_size=500, paged_cookie=cookie)
        entries += [item for item in connection.response or [] if item.get("type") == "searchResEntry"]
        cookie = (connection.result.get("controls") or {}).get(_PAGED_RESULTS, {}).get("value", {}).get("cookie")
        if not cookie:
            return entries


def read_directory_people(username: str, password: str) -> DirectorySnapshot:
    """Read every active directory account as a person, using the caller's own login."""
    config = load_config()
    rdn, users_base = config.user_dn_template.split(",", 1)
    uid_attribute = rdn.split("=", 1)[0].strip()
    group_dn = os.getenv("LDAP_RESPONSIBLE_GROUP_DN", "").strip() or None

    with _bound_connection(config, username, password) as (connection, _):
        group_members: set[str] = set()
        group_found = False
        if group_dn:
            group = _search_one(connection, group_dn, "(objectClass=*)", ["member", "uniqueMember"])
            group_found = group is not None
            for dn in (group or {}).get("member", []) + (group or {}).get("uniqueMember", []):
                group_members.add(_normalize_dn(str(dn)))

        attributes = [uid_attribute, "cn", "displayName", "givenName", "sn", "mail",
                      "telephoneNumber", "mobile", "nsAccountLock", "memberOf"]
        people = []
        for item in _search_all(connection, users_base, "(objectClass=person)", attributes):
            entry = item.get("attributes") or {}
            uid = _first(entry, uid_attribute)
            locked = str(_first(entry, "nsAccountLock") or "").upper() == "TRUE"
            if not uid or locked or uid in NON_PERSON_ACCOUNTS:
                continue
            full_name = " ".join(part for part in (_first(entry, "givenName"), _first(entry, "sn")) if part)
            member_of = {_normalize_dn(str(dn)) for dn in entry.get("memberOf") or []}
            people.append(DirectoryPerson(
                uid=uid,
                name=(_first(entry, "displayName") or _first(entry, "cn") or full_name or uid)[:200],
                email=((_first(entry, "mail") or "")[:254] or None),
                phone=((_first(entry, "telephoneNumber") or _first(entry, "mobile") or "")[:80] or None),
                responsible=bool(group_dn) and (
                    _normalize_dn(group_dn) in member_of or _normalize_dn(str(item.get("dn", ""))) in group_members
                ),
            ))
    return DirectorySnapshot(people=people, responsible_group=group_dn, responsible_group_found=group_found)
