"""Importing people from the LDAP directory (FreeIPA layout, in-memory mock)."""
import os
import sqlite3
import subprocess
import sys

import pytest
from fastapi.testclient import TestClient
from ldap3 import MOCK_SYNC, Connection, Server

from app import models
from app.database import SessionLocal
from app.main import app
from app.services import ldap_auth

BASE_DN = "dc=example,dc=test"
USERS_DN = f"cn=users,cn=accounts,{BASE_DN}"
GROUPS_DN = f"cn=groups,cn=accounts,{BASE_DN}"
ADMINS = f"cn=sysadmin,{GROUPS_DN}"
FACULTY = f"cn=faculty,{GROUPS_DN}"


def user(uid, name, *, mail=None, phone=None, groups=(), locked=False):
    attributes = {"objectClass": ["person", "inetOrgPerson"], "uid": uid, "cn": name, "displayName": name,
                  "userPassword": f"pw-{uid}", "memberOf": list(groups)}
    if mail:
        attributes["mail"] = mail
    if phone:
        attributes["telephoneNumber"] = phone
    if locked:
        attributes["nsAccountLock"] = "TRUE"
    return uid, attributes


DIRECTORY = dict([
    user("ana", "Ana Popescu", mail="ana@example.test", groups=[ADMINS]),
    user("bogdan", "Bogdan Ionescu", mail="bogdan@example.test", phone="0700 000 001", groups=[FACULTY]),
    user("carmen", "Carmen Marin", mail="CARMEN@example.test"),
    user("elena", "Elena Dobre"),
    user("dan", "Dan Locked", mail="dan@example.test", locked=True),
    user("admin", "Administrator", groups=[ADMINS]),
])


@pytest.fixture
def directory(monkeypatch):
    monkeypatch.setenv("LDAP_SERVER_URI", "ldaps://ipa.example.test")
    monkeypatch.setenv("LDAP_USER_DN_TEMPLATE", f"uid={{username}},{USERS_DN}")
    monkeypatch.setenv("LDAP_REQUIRED_GROUP_DN", ADMINS)
    monkeypatch.setenv("LDAP_RESPONSIBLE_GROUP_DN", FACULTY)
    monkeypatch.setattr(ldap_auth, "CLIENT_STRATEGY", MOCK_SYNC)

    def publish(entries):
        # A fresh in-memory directory per state, as FreeIPA would answer after edits.
        server = Server("ipa.example.test")
        seed = Connection(server, client_strategy=MOCK_SYNC)
        for uid, attributes in entries.items():
            seed.strategy.add_entry(f"uid={uid},{USERS_DN}", attributes)
        for group in (ADMINS, FACULTY):
            members = [f"uid={uid},{USERS_DN}" for uid, attrs in entries.items() if group in attrs["memberOf"]]
            seed.strategy.add_entry(group, {"objectClass": ["groupOfNames"], "cn": group.split(",")[0][3:], "member": members})
        monkeypatch.setattr(ldap_auth, "_server", lambda config: server)

    publish(DIRECTORY)
    return publish


@pytest.fixture
def ana(client, directory):
    """The signed-in administrator, logged in with FreeIPA (session as ana)."""
    with TestClient(app) as session:
        response = session.post("/auth/login", json={"username": "ana", "password": "pw-ana"})
        assert response.status_code == 200, response.text
        session.headers["Authorization"] = "Bearer " + response.json()["token"]
        yield session


def people_by_name(client):
    return {person["name"]: person for person in client.get("/people/").json()}


def test_first_import_creates_links_and_assigns_roles(client, ana):
    carmen_manual = client.post("/people/", json={"name": "Carmen M.", "email": "carmen@example.test"}).json()
    visitor = client.post("/people/", json={"name": "Vizitator", "email": "guest@elsewhere.test"}).json()

    response = ana.post("/people/directory-sync", json={"password": "pw-ana"})
    assert response.status_code == 200, response.text
    result = response.json()
    assert sorted(result["created"]) == ["Ana Popescu", "Bogdan Ionescu", "Elena Dobre"]
    assert result["linked"] == ["Carmen Marin"]
    assert (result["directory_people"], result["responsible_group"], result["responsible_group_found"]) == (4, FACULTY, True)
    assert result["skipped"] == result["deactivated"] == []

    people = people_by_name(client)
    assert "Dan Locked" not in people and "Administrator" not in people
    assert people["Carmen Marin"]["id"] == carmen_manual["id"] and people["Carmen Marin"]["ldap_uid"] == "carmen"
    assert people["Bogdan Ionescu"] | {"id": 0} == {
        "id": 0, "name": "Bogdan Ionescu", "email": "bogdan@example.test", "phone": "0700 000 001",
        "is_borrower": True, "is_responsible": True, "active": True, "ldap_uid": "bogdan",
    }
    assert not people["Ana Popescu"]["is_responsible"] and people["Ana Popescu"]["is_borrower"]
    assert people["Vizitator"] == visitor | {"ldap_uid": None}

    with SessionLocal() as db:
        event = db.query(models.AuditEvent).filter_by(event_type="PEOPLE_DIRECTORY_SYNC").one()
    assert "Ana Popescu (ana)" in event.description and "3 noi" in event.description

    again = ana.post("/people/directory-sync", json={"password": "pw-ana"}).json()
    assert again["created"] == again["updated"] == again["linked"] == again["deactivated"] == []


def test_directory_changes_update_deactivate_and_report_conflicts(client, ana, directory):
    ana.post("/people/directory-sync", json={"password": "pw-ana"})
    people = people_by_name(client)
    room = client.post("/locations/", json={"name": "Lab"}).json()
    tag = client.post("/tags/batches", json={"quantity": 2}).json()["tags"]
    owned = client.post("/devices/", json={"name": "Osciloscop", "category": "X", "location_id": room["id"],
                                           "responsible_person_id": people["Bogdan Ionescu"]["id"], "tag_code": tag[0]["code"]}).json()
    lent = client.post("/devices/", json={"name": "Camera", "category": "X", "location_id": room["id"], "tag_code": tag[1]["code"]}).json()
    assert client.post("/loans/", json={"device_id": lent["id"], "person_id": people["Carmen Marin"]["id"]}).status_code == 201

    changed = dict(DIRECTORY)
    changed["ana"] = user("ana", "Ana Popescu-Radu", mail="ana@example.test", groups=[ADMINS])[1]
    changed["bogdan"] = user("bogdan", "Bogdan Ionescu", mail="bogdan@example.test", phone="0700 000 001")[1]
    changed["elena"] = user("elena", "Elena Dobre", locked=True)[1]
    del changed["carmen"]
    directory(changed)

    result = ana.post("/people/directory-sync", json={"password": "pw-ana"}).json()
    assert result["updated"] == ["Ana Popescu-Radu"]
    assert result["deactivated"] == ["Elena Dobre"]
    reasons = {issue["name"]: issue["reason"] for issue in result["skipped"]}
    assert set(reasons) == {"Bogdan Ionescu", "Carmen Marin"}
    assert "obiecte în grijă" in reasons["Bogdan Ionescu"] and "împrumut activ" in reasons["Carmen Marin"]

    people = people_by_name(client)
    assert people["Bogdan Ionescu"]["is_responsible"] and client.get(f"/devices/{owned['id']}").json()["responsible_person_id"]
    assert people["Carmen Marin"]["active"] and not people["Elena Dobre"]["active"]

    # Re-enabled in FreeIPA: active again on the next run.
    directory(DIRECTORY)
    assert ana.post("/people/directory-sync", json={"password": "pw-ana"}).json()["reactivated"] == ["Elena Dobre"]


def test_without_a_responsible_group_roles_set_in_the_app_are_kept(client, ana, monkeypatch):
    monkeypatch.setenv("LDAP_RESPONSIBLE_GROUP_DN", "")
    ana.post("/people/directory-sync", json={"password": "pw-ana"})
    elena = people_by_name(client)["Elena Dobre"]
    client.put(f"/people/{elena['id']}", json={"is_responsible": True})
    result = ana.post("/people/directory-sync", json={"password": "pw-ana"}).json()
    assert result["responsible_group"] is None and result["updated"] == []
    assert people_by_name(client)["Elena Dobre"]["is_responsible"]


def test_import_refuses_bad_credentials_and_changes_nothing(client, ana, directory, monkeypatch):
    # 403, not 401: a wrong directory password must not end the admin session.
    assert ana.post("/people/directory-sync", json={"password": "wrong"}).status_code == 403
    assert ana.get("/auth/me").status_code == 200
    assert ana.post("/people/directory-sync", json={"username": "x)(uid=*", "password": "pw-ana"}).status_code == 403
    # The password-based admin session must name the directory account.
    assert client.post("/people/directory-sync", json={"password": "pw-ana"}).status_code == 400
    assert client.post("/people/directory-sync", json={"username": "ana", "password": "pw-ana"}).status_code == 200
    # An empty answer (e.g. no read rights) must never deactivate everyone.
    directory({"ana": DIRECTORY["ana"] | {"nsAccountLock": "TRUE"}})
    empty = client.post("/people/directory-sync", json={"username": "ana", "password": "pw-ana"})
    assert empty.status_code == 409 and "Nu s-a modificat nimic" in empty.json()["detail"]
    assert all(person["active"] for person in client.get("/people/").json())

    monkeypatch.setenv("LDAP_SERVER_URI", "")
    assert client.post("/people/directory-sync", json={"username": "ana", "password": "pw-ana"}).status_code == 503
    with TestClient(app) as anonymous:
        assert anonymous.post("/people/directory-sync", json={"password": "x"}).status_code == 401


def test_existing_databases_get_the_directory_link_column(tmp_path):
    db = tmp_path / "legacy.db"
    with sqlite3.connect(db) as con:
        con.executescript("""
        CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT, phone TEXT, active INTEGER NOT NULL DEFAULT 1,
                             is_borrower INTEGER NOT NULL DEFAULT 1, is_responsible INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE locations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT, active INTEGER NOT NULL DEFAULT 1);
        INSERT INTO people (id, name) VALUES (1, 'Existing');
        """)
    env = dict(os.environ, DATABASE_URL="sqlite:///" + str(db))
    for _ in range(2):
        subprocess.run([sys.executable, "-c", "from app.main import app"], env=env, check=True, capture_output=True)
    with sqlite3.connect(db) as con:
        assert con.execute("SELECT name, ldap_uid FROM people").fetchall() == [("Existing", None)]
        con.execute("UPDATE people SET ldap_uid = 'ana' WHERE id = 1")
        with pytest.raises(sqlite3.IntegrityError):
            con.execute("INSERT INTO people (id, name, ldap_uid) VALUES (2, 'Duplicate', 'ana')")
