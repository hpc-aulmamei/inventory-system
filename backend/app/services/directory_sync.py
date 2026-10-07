"""Bring people from the LDAP directory (FreeIPA) into the inventory.

Every active directory account is a borrower; members of the configured
responsible group are also responsible for items. For linked people the
directory is the source of truth: name, email, phone and roles follow it on
each run. People added by hand are never changed, except that one whose email
matches a directory account is linked to it instead of being duplicated.
"""

import json

from sqlalchemy.orm import Session

from app import models
from app.services.audit import record_activity
from app.services.code_generator import reserve_entity_id
from app.services.ldap_auth import DirectorySnapshot


def _has_active_loan(db: Session, person: models.Person) -> bool:
    return db.query(models.Loan).filter(
        models.Loan.person_id == person.id, models.Loan.status == "ACTIVE",
    ).first() is not None


def _is_responsible_for_items(db: Session, person: models.Person) -> bool:
    return db.query(models.Device).filter(models.Device.responsible_person_id == person.id).first() is not None


def sync_people(db: Session, snapshot: DirectorySnapshot, actor: str) -> dict:
    """Apply the directory to the people table. The caller owns the transaction."""
    report = {"created": [], "updated": [], "linked": [], "deactivated": [], "reactivated": [], "skipped": []}

    linked = {person.ldap_uid: person for person in db.query(models.Person).filter(models.Person.ldap_uid.isnot(None))}
    unlinked_by_email: dict[str, list[models.Person]] = {}
    for person in db.query(models.Person).filter(models.Person.ldap_uid.is_(None), models.Person.email.isnot(None)):
        unlinked_by_email.setdefault(person.email.strip().lower(), []).append(person)

    def skip(person: models.Person, reason: str) -> None:
        report["skipped"].append({"person_id": person.id, "name": person.name, "reason": reason})

    seen = set()
    for entry in snapshot.people:
        seen.add(entry.uid)
        person = linked.get(entry.uid)
        newly_linked = False
        if person is None and entry.email:
            matches = unlinked_by_email.get(entry.email.strip().lower(), [])
            if len(matches) == 1:
                person = matches[0]
                person.ldap_uid = entry.uid
                newly_linked = True

        if person is None:
            person = models.Person(
                id=reserve_entity_id(db, models.Person, "person", models.AuditEvent.person_id),
                ldap_uid=entry.uid, name=entry.name, email=entry.email, phone=entry.phone,
                active=1, is_borrower=1, is_responsible=int(entry.responsible),
            )
            db.add(person)
            db.flush()
            report["created"].append(entry.name)
            continue

        before = (person.name, person.email, person.phone, person.is_borrower, person.is_responsible)
        person.name = entry.name
        # Keep contact details typed in the app when the directory has none.
        person.email = entry.email or person.email
        person.phone = entry.phone or person.phone
        person.is_borrower = 1
        if not person.active:
            person.active = 1
            report["reactivated"].append(person.name)
        if snapshot.responsible_group is not None:
            if entry.responsible:
                person.is_responsible = 1
            elif person.is_responsible:
                if _is_responsible_for_items(db, person):
                    skip(person, "Nu mai este în grupul de responsabili, dar are obiecte în grijă; reasociază-le.")
                else:
                    person.is_responsible = 0
        if newly_linked:
            report["linked"].append(person.name)
        elif (person.name, person.email, person.phone, person.is_borrower, person.is_responsible) != before:
            report["updated"].append(person.name)

    # Accounts that were deleted or disabled in the directory.
    for uid, person in linked.items():
        if uid in seen or not person.active:
            continue
        if _has_active_loan(db, person):
            skip(person, "Contul nu mai există sau este dezactivat în FreeIPA, dar are un împrumut activ.")
        elif _is_responsible_for_items(db, person):
            skip(person, "Contul nu mai există sau este dezactivat în FreeIPA, dar are obiecte în grijă.")
        else:
            person.active = 0
            report["deactivated"].append(person.name)

    db.flush()
    counts = {key: len(value) for key, value in report.items()}
    record_activity(
        db,
        event_type="PEOPLE_DIRECTORY_SYNC",
        category="PEOPLE",
        severity="WARNING" if report["skipped"] else "INFO",
        title="Persoane sincronizate din FreeIPA",
        description=(
            f"{actor}: {counts['created']} noi, {counts['updated']} actualizate, {counts['linked']} legate, "
            f"{counts['deactivated']} dezactivate, {counts['reactivated']} reactivate, {counts['skipped']} de verificat."
        ),
        details={**counts, "directory_people": len(snapshot.people), "skipped": report["skipped"],
                 "deactivated": report["deactivated"], "responsible_group": snapshot.responsible_group},
        notify=bool(report["skipped"]),
    )
    db.add(models.Log(action="PEOPLE_DIRECTORY_SYNC", new_value=json.dumps(counts)))
    return {
        **report,
        "directory_people": len(snapshot.people),
        "responsible_group": snapshot.responsible_group,
        "responsible_group_found": snapshot.responsible_group_found,
    }
