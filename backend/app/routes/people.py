import json

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from app import models, schemas
from app.database import begin_inventory_write, get_db
from app.services import directory_sync, ldap_auth
from app.services.code_generator import reserve_entity_id

router = APIRouter(prefix="/people", tags=["People"])


def ensure_no_assignments(db: Session, person_id: int):
    if db.query(models.Device).filter(models.Device.responsible_person_id == person_id).first():
        raise HTTPException(status_code=409, detail="Reasociază sau elimină mai întâi obiectele acestei persoane responsabile.")


@router.get("/{person_id}/devices", response_model=list[schemas.DeviceResponse])
def responsible_devices(person_id: int, db: Session = Depends(get_db)):
    if db.get(models.Person, person_id) is None:
        raise HTTPException(status_code=404, detail="Person not found")
    return db.query(models.Device).filter(models.Device.responsible_person_id == person_id).order_by(models.Device.id).all()


def person_snapshot(person: models.Person) -> str:
    return json.dumps(
        {
            "id": person.id,
            "name": person.name,
            "email": person.email,
            "phone": person.phone,
            "active": bool(person.active),
            "is_responsible": bool(person.is_responsible),
            "is_borrower": bool(person.is_borrower),
        },
        ensure_ascii=False,
    )


@router.get("/", response_model=list[schemas.PersonResponse])
def get_people(
    include_inactive: bool = Query(True),
    role: str | None = Query(None, pattern="^(responsible|borrower)$"),
    db: Session = Depends(get_db),
):
    query = db.query(models.Person)
    if role == "responsible":
        query = query.filter(models.Person.is_responsible == 1)
    elif role == "borrower":
        query = query.filter(models.Person.is_borrower == 1)

    if not include_inactive:
        query = query.filter(models.Person.active == 1)

    return query.order_by(models.Person.name.asc()).all()


@router.post("/directory-sync", response_model=schemas.DirectorySyncResponse)
def sync_from_directory(payload: schemas.DirectorySyncRequest, request: Request, db: Session = Depends(get_db)):
    if not ldap_auth.ldap_enabled():
        raise HTTPException(status_code=503, detail="LDAP_SERVER_URI is not configured in backend/.env")
    admin = request.state.admin
    username = (payload.username or "").strip() or (admin.username if admin.method == "ldap" else "")
    if not username:
        raise HTTPException(status_code=400, detail="Introdu utilizatorul FreeIPA cu care se citește directorul.")

    # Read the directory before taking the write lock: it can take a while.
    try:
        snapshot = ldap_auth.read_directory_people(username, payload.password)
    except ldap_auth.LdapInvalidCredentials:
        # Not 401: the admin session is fine, and the frontend treats 401 as a logout.
        raise HTTPException(status_code=403, detail="Utilizator sau parolă FreeIPA incorectă.") from None
    except ldap_auth.LdapUnavailable:
        raise HTTPException(status_code=503, detail="Serverul LDAP nu este disponibil. Încearcă din nou.") from None
    if not snapshot.people:
        # An empty answer more likely means missing read rights than an empty
        # directory; never deactivate everyone because of it.
        raise HTTPException(status_code=409, detail="Directorul nu a returnat niciun cont activ. Nu s-a modificat nimic.")

    begin_inventory_write(db)
    result = directory_sync.sync_people(db, snapshot, actor=f"{admin.display_name} ({username})")
    db.commit()
    return result


@router.get("/{person_id}", response_model=schemas.PersonResponse)
def get_person(person_id: int, db: Session = Depends(get_db)):
    person = db.query(models.Person).filter(models.Person.id == person_id).first()

    if person is None:
        raise HTTPException(status_code=404, detail="Person not found")

    return person


@router.post("/", response_model=schemas.PersonResponse, status_code=201)
def create_person(person: schemas.PersonCreate, db: Session = Depends(get_db)):
    begin_inventory_write(db)
    if not person.name.strip():
        raise HTTPException(status_code=400, detail="Name cannot be empty")

    if not person.is_responsible and not person.is_borrower:
        raise HTTPException(status_code=400, detail="Selectează cel puțin un rol.")

    db_person = models.Person(
        id=reserve_entity_id(db, models.Person, "person", models.AuditEvent.person_id),
        name=person.name.strip(),
        email=person.email.strip() if person.email else None,
        phone=person.phone.strip() if person.phone else None,
        active=1,
        is_responsible=int(person.is_responsible),
        is_borrower=int(person.is_borrower),
    )

    db.add(db_person)
    db.flush()

    db.add(
        models.Log(
            action="PERSON_CREATED",
            new_value=person_snapshot(db_person),
        )
    )

    db.commit()
    db.refresh(db_person)
    return db_person


@router.put("/{person_id}", response_model=schemas.PersonResponse)
def update_person(
    person_id: int,
    person_update: schemas.PersonUpdate,
    db: Session = Depends(get_db),
):
    begin_inventory_write(db)
    db_person = db.query(models.Person).filter(models.Person.id == person_id).first()

    if db_person is None:
        raise HTTPException(status_code=404, detail="Person not found")

    update_data = person_update.model_dump(exclude_unset=True)

    if "name" in update_data:
        if update_data["name"] is None or not update_data["name"].strip():
            raise HTTPException(status_code=400, detail="Name cannot be empty")
        update_data["name"] = update_data["name"].strip()

    if "email" in update_data and update_data["email"]:
        update_data["email"] = update_data["email"].strip()

    if "phone" in update_data and update_data["phone"]:
        update_data["phone"] = update_data["phone"].strip()

    for field in ("active", "is_responsible", "is_borrower"):
        if field in update_data and update_data[field] is None:
            raise HTTPException(status_code=400, detail=f"{field} cannot be null")
    if not update_data.get("is_responsible", db_person.is_responsible) and not update_data.get("is_borrower", db_person.is_borrower):
        raise HTTPException(status_code=400, detail="Selectează cel puțin un rol.")
    if update_data.get("active") is False or update_data.get("is_responsible") is False:
        ensure_no_assignments(db, person_id)

    if update_data.get("active") is False or update_data.get("is_borrower") is False:
        active_loan = (
            db.query(models.Loan)
            .filter(
                models.Loan.person_id == person_id,
                models.Loan.status == "ACTIVE",
            )
            .first()
        )
        if active_loan:
            raise HTTPException(
                status_code=409,
                detail="Person has an active loan and cannot be deactivated",
            )

    old_value = person_snapshot(db_person)

    for field, value in update_data.items():
        if field == "active" and value is not None:
            value = 1 if value else 0
        setattr(db_person, field, value)

    db.flush()

    db.add(
        models.Log(
            action="PERSON_UPDATED",
            old_value=old_value,
            new_value=person_snapshot(db_person),
        )
    )

    db.commit()
    db.refresh(db_person)
    return db_person


@router.delete("/{person_id}")
def deactivate_person(person_id: int, db: Session = Depends(get_db)):
    begin_inventory_write(db)
    db_person = db.query(models.Person).filter(models.Person.id == person_id).first()

    if db_person is None:
        raise HTTPException(status_code=404, detail="Person not found")

    active_loan = (
        db.query(models.Loan)
        .filter(
            models.Loan.person_id == person_id,
            models.Loan.status == "ACTIVE",
        )
        .first()
    )

    if active_loan:
        raise HTTPException(
            status_code=409,
            detail="Person has an active loan and cannot be deactivated",
        )

    ensure_no_assignments(db, person_id)

    if not db_person.active:
        return {"message": "Person is already inactive"}

    old_value = person_snapshot(db_person)
    db_person.active = 0
    db.flush()

    db.add(
        models.Log(
            action="PERSON_DEACTIVATED",
            old_value=old_value,
            new_value=person_snapshot(db_person),
        )
    )

    db.commit()
    return {"message": "Person deactivated"}
