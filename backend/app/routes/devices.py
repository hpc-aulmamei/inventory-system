import io
import json
import secrets
import shutil
import uuid
import warnings
from datetime import datetime, timezone
from urllib.parse import urlparse
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy.orm import Session
from PIL import Image, ImageOps, UnidentifiedImageError
from starlette.concurrency import run_in_threadpool

import qrcode
import qrcode.image.svg

from app import models, schemas
from app.database import begin_inventory_write, get_db
from app.services.code_generator import generate_device_code, reserve_entity_id
from app.routes.tags import find_assignable_tag, mark_assigned, mark_free, record_tag_change
from app.services.audit import record_activity
from app.services.security import UPLOAD_DIR

router = APIRouter(prefix="/devices", tags=["Devices"])

VALID_STATUSES = {"AVAILABLE", "LOANED", "IN_USE", "BROKEN", "LOST", "RETIRED"}
MAX_IMAGE_SIZE = 8 * 1024 * 1024
MAX_IMAGE_PIXELS = 16_000_000
UPLOAD_ROOT = UPLOAD_DIR / "devices"
UPLOAD_ROOT.mkdir(parents=True, exist_ok=True)




def normalize_frontend_base_url(value: str) -> str:
    base_url = (value or "").strip().rstrip("/")
    try:
        parsed = urlparse(base_url)
        valid_port = parsed.port is None or 1 <= parsed.port <= 65535
    except ValueError:
        raise HTTPException(status_code=400, detail="Frontend base URL must be a valid http/https URL") from None
    if (
        parsed.scheme not in {"http", "https"} or not parsed.hostname
        or parsed.username is not None or parsed.password is not None
        or parsed.path not in {"", "/"} or parsed.query or parsed.fragment or not valid_port
        or any(character.isspace() or ord(character) < 32 for character in base_url)
        or "\\" in base_url
    ):
        raise HTTPException(status_code=400, detail="Frontend base URL must be a valid http/https URL")
    if len(base_url) > 500:
        raise HTTPException(status_code=400, detail="Frontend base URL is too long")
    return base_url


def new_public_token(db: Session) -> str:
    while True:
        token = secrets.token_urlsafe(24)
        exists = db.query(models.DevicePublicLink).filter(models.DevicePublicLink.token == token).first()
        if exists is None:
            return token


def make_qr_svg(value: str) -> str:
    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=8,
        border=2,
    )
    qr.add_data(value)
    qr.make(fit=True)
    image = qr.make_image(image_factory=qrcode.image.svg.SvgPathImage)
    output = io.BytesIO()
    image.save(output)
    return output.getvalue().decode("utf-8")


def public_access_payload(link: models.DevicePublicLink, base_url: str) -> dict:
    public_path = f"/asset/{link.token}"
    public_url = f"{base_url}{public_path}"
    return {
        "enabled": bool(link.is_active),
        "public_url": public_url,
        "public_path": public_path,
        "token": link.token,
        "qr_svg": make_qr_svg(public_url),
        "created_at": link.created_at,
        "regenerated_at": link.regenerated_at,
    }


def log_public_access_change(
    db: Session,
    *,
    device: models.Device,
    event_type: str,
    title: str,
    description: str,
    token: str,
):
    db.add(
        models.Log(
            device_id=device.id,
            action=event_type,
            new_value=json.dumps({"public_token_suffix": token[-6:]}, ensure_ascii=False),
        )
    )
    record_activity(
        db,
        event_type=event_type,
        category="ACCESS",
        severity="INFO",
        title=title,
        description=description,
        entity_type="device",
        entity_id=device.id,
        device_id=device.id,
        details={"code": device.code, "token_suffix": token[-6:]},
        notify=False,
    )


def device_snapshot(device: models.Device) -> str:
    return json.dumps(
        {
            "id": device.id,
            "code": device.code,
            "name": device.name,
            "category": device.category,
            "serial_number": device.serial_number,
            "status": device.status,
            "location_id": device.location_id,
            "responsible_person_id": device.responsible_person_id,
            "description": device.description,
            "tag_code": device.tag_code,
        },
        ensure_ascii=False,
    )


def validate_references(
    db: Session,
    location_id: int | None,
    responsible_person_id: int | None,
):
    if location_id is not None:
        location = db.query(models.Location).filter(models.Location.id == location_id).first()
        if location is None:
            raise HTTPException(status_code=404, detail="Location not found")
        if not location.active:
            raise HTTPException(status_code=409, detail="Location is inactive")

    if responsible_person_id is not None:
        person = (
            db.query(models.Person)
            .filter(models.Person.id == responsible_person_id)
            .first()
        )
        if person is None:
            raise HTTPException(status_code=404, detail="Responsible person not found")
        if not person.is_responsible:
            raise HTTPException(status_code=409, detail="Persoana nu are rol de responsabil.")
        if not person.active:
            raise HTTPException(status_code=409, detail="Responsible person is inactive")


def validate_status(status: str):
    if status not in VALID_STATUSES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid device status. Allowed: {', '.join(sorted(VALID_STATUSES))}",
        )


def get_device_or_404(db: Session, device_id: int) -> models.Device:
    device = db.query(models.Device).filter(models.Device.id == device_id).first()
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")
    return device


def get_location(db: Session, location_id: int | None) -> models.Location | None:
    if location_id is None:
        return None
    return db.query(models.Location).filter(models.Location.id == location_id).first()


def image_to_response(image: models.DeviceImage) -> dict:
    return {
        "id": image.id,
        "device_id": image.device_id,
        "original_name": image.original_name,
        "content_type": image.content_type,
        "url": f"/uploads/devices/{image.device_id}/{image.stored_name}",
        "uploaded_at": image.uploaded_at,
    }


def sanitize_image(data: bytes) -> tuple[bytes, str, str]:
    """Validate decoded raster content and remove metadata/trailing payloads."""
    formats = {"PNG": (".png", "image/png"), "JPEG": (".jpg", "image/jpeg"), "WEBP": (".webp", "image/webp")}
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as source:
                image_format = source.format
                if image_format not in formats:
                    raise HTTPException(status_code=400, detail="Only PNG, JPEG and WEBP images are supported")
                if source.width * source.height > MAX_IMAGE_PIXELS:
                    raise HTTPException(status_code=413, detail="Image exceeds the maximum of 16 million pixels")
                if getattr(source, "is_animated", False):
                    raise HTTPException(status_code=400, detail="Upload a static image")
                source.verify()
            with Image.open(io.BytesIO(data)) as source:
                source.load()
                oriented = ImageOps.exif_transpose(source)
                # Saving only pixels discards embedded text, EXIF/GPS and any
                # bytes appended after the image. Preserve visible alpha.
                has_alpha = "A" in oriented.getbands() or "transparency" in source.info
                cleaned = oriented.convert("RGBA" if has_alpha and image_format != "JPEG" else "RGB")
                cleaned.info.clear()
                output = io.BytesIO()
                cleaned.save(output, format=image_format, quality=90)
                payload = output.getvalue()
                if len(payload) > MAX_IMAGE_SIZE:
                    raise HTTPException(status_code=413, detail="Decoded image is larger than 8 MB; reduce its dimensions")
                return payload, *formats[image_format]
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise HTTPException(status_code=400, detail="The image is corrupt or cannot be decoded") from None


def record_location_change(
    db: Session,
    device_id: int,
    old_location: models.Location | None,
    new_location: models.Location,
    change_type: str,
):
    db.add(
        models.DeviceLocationHistory(
            device_id=device_id,
            from_location_id=old_location.id if old_location else None,
            from_location_name=old_location.name if old_location else None,
            to_location_id=new_location.id,
            to_location_name=new_location.name,
            change_type=change_type,
        )
    )


@router.get("/", response_model=list[schemas.DeviceResponse])
def get_devices(db: Session = Depends(get_db)):
    return db.query(models.Device).order_by(models.Device.id.desc()).all()


@router.get("/{device_id}", response_model=schemas.DeviceResponse)
def get_device(device_id: int, db: Session = Depends(get_db)):
    return get_device_or_404(db, device_id)


@router.get("/{device_id}/tracking", response_model=schemas.DeviceTrackingResponse)
def get_device_tracking(device_id: int, db: Session = Depends(get_db)):
    device = get_device_or_404(db, device_id)
    current_location = get_location(db, device.location_id)
    history = (
        db.query(models.DeviceLocationHistory)
        .filter(models.DeviceLocationHistory.device_id == device_id)
        .order_by(models.DeviceLocationHistory.id.desc())
        .all()
    )
    images = (
        db.query(models.DeviceImage)
        .filter(models.DeviceImage.device_id == device_id)
        .order_by(models.DeviceImage.id.desc())
        .all()
    )

    return {
        "device": device,
        "current_location": current_location,
        "location_history": history,
        "images": [image_to_response(image) for image in images],
    }


@router.get("/{device_id}/images", response_model=list[schemas.DeviceImageResponse])
def get_device_images(device_id: int, db: Session = Depends(get_db)):
    get_device_or_404(db, device_id)
    images = (
        db.query(models.DeviceImage)
        .filter(models.DeviceImage.device_id == device_id)
        .order_by(models.DeviceImage.id.desc())
        .all()
    )
    return [image_to_response(image) for image in images]


@router.post("/", response_model=schemas.DeviceResponse, status_code=201)
def create_device(device: schemas.DeviceCreate, db: Session = Depends(get_db)):
    begin_inventory_write(db)
    status = device.status.upper()
    validate_status(status)

    if status == "LOANED":
        raise HTTPException(
            status_code=409,
            detail="Use the Loans section to mark a device as loaned",
        )

    validate_references(db, device.location_id, device.responsible_person_id)
    location = get_location(db, device.location_id)
    if location is None:
        raise HTTPException(status_code=400, detail="A location is required for every new device")

    if not device.name.strip() or not device.category.strip():
        raise HTTPException(status_code=400, detail="Name and category are required")
    if not device.tag_code:
        raise HTTPException(status_code=400, detail="Scanează eticheta lipită pe obiect. Etichetele se tipăresc din pagina Etichete.")
    tag = find_assignable_tag(db, device.tag_code)

    device_id = reserve_entity_id(db, models.Device, "device", models.AuditEvent.device_id)
    db_device = models.Device(
        id=device_id,
        code=generate_device_code(device_id),
        name=device.name.strip(),
        category=device.category.strip(),
        serial_number=device.serial_number.strip() if device.serial_number else None,
        status=status,
        location_id=device.location_id,
        responsible_person_id=device.responsible_person_id,
        description=device.description.strip() if device.description else None,
    )

    db.add(db_device)
    db.flush()
    # Sticking a pre-printed tag on the item is what brings it into the inventory.
    mark_assigned(tag, db_device)
    db.flush()
    db.expire(db_device, ["tag"])

    record_location_change(
        db,
        device_id=db_device.id,
        old_location=None,
        new_location=location,
        change_type="INITIAL_ASSIGNMENT",
    )

    db.add(
        models.Log(
            device_id=db_device.id,
            action="DEVICE_CREATED",
            new_value=device_snapshot(db_device),
        )
    )

    db.add(
        models.Log(
            device_id=db_device.id,
            action="DEVICE_LOCATION_ASSIGNED",
            new_value=json.dumps(
                {"location_id": location.id, "location_name": location.name},
                ensure_ascii=False,
            ),
        )
    )

    record_activity(
        db,
        event_type="DEVICE_CREATED",
        category="INVENTORY",
        severity="INFO",
        title="Obiect adăugat în inventar",
        description=(
            f"{db_device.code} · {db_device.name} a fost înregistrat în locația {location.name} "
            f"cu eticheta {tag.code}."
        ),
        entity_type="device",
        entity_id=db_device.id,
        device_id=db_device.id,
        location_id=location.id,
        details={
            "code": db_device.code,
            "name": db_device.name,
            "category": db_device.category,
            "status": db_device.status,
            "location_name": location.name,
            "tag_code": tag.code,
        },
        notify=True,
    )

    db.commit()
    db.refresh(db_device)
    return db_device






@router.get("/{device_id}/public-access", response_model=schemas.DevicePublicAccessResponse)
def get_public_access(
    device_id: int,
    base_url: str,
    db: Session = Depends(get_db),
):
    get_device_or_404(db, device_id)
    link = (
        db.query(models.DevicePublicLink)
        .filter(
            models.DevicePublicLink.device_id == device_id,
            models.DevicePublicLink.is_active == 1,
        )
        .first()
    )
    if link is None:
        raise HTTPException(status_code=404, detail="Public access is not enabled for this device")
    return public_access_payload(link, normalize_frontend_base_url(base_url))


@router.post("/{device_id}/public-access", response_model=schemas.DevicePublicAccessResponse)
def create_or_get_public_access(
    device_id: int,
    payload: schemas.PublicAccessRequest,
    db: Session = Depends(get_db),
):
    begin_inventory_write(db)
    device = get_device_or_404(db, device_id)
    base_url = normalize_frontend_base_url(payload.base_url)
    link = (
        db.query(models.DevicePublicLink)
        .filter(models.DevicePublicLink.device_id == device_id)
        .first()
    )

    created = False
    if link is None:
        link = models.DevicePublicLink(
            device_id=device_id,
            token=new_public_token(db),
            is_active=1,
        )
        db.add(link)
        db.flush()
        created = True
    elif not link.is_active:
        link.token = new_public_token(db)
        link.is_active = 1
        link.regenerated_at = datetime.now(timezone.utc)
        db.flush()
        created = True

    if created:
        log_public_access_change(
            db,
            device=device,
            event_type="DEVICE_PUBLIC_ACCESS_ENABLED",
            title="Acces QR activat",
            description=f"A fost activat un link de vizualizare read-only pentru {device.code} · {device.name}.",
            token=link.token,
        )
        db.commit()
        db.refresh(link)

    return public_access_payload(link, base_url)


@router.post("/{device_id}/public-access/regenerate", response_model=schemas.DevicePublicAccessResponse)
def regenerate_public_access(
    device_id: int,
    payload: schemas.PublicAccessRequest,
    db: Session = Depends(get_db),
):
    begin_inventory_write(db)
    device = get_device_or_404(db, device_id)
    base_url = normalize_frontend_base_url(payload.base_url)
    link = (
        db.query(models.DevicePublicLink)
        .filter(models.DevicePublicLink.device_id == device_id)
        .first()
    )

    if link is None:
        link = models.DevicePublicLink(device_id=device_id, token=new_public_token(db), is_active=1)
        db.add(link)
    else:
        link.token = new_public_token(db)
        link.is_active = 1
        link.regenerated_at = datetime.now(timezone.utc)
    db.flush()

    log_public_access_change(
        db,
        device=device,
        event_type="DEVICE_PUBLIC_ACCESS_REGENERATED",
        title="Cod QR regenerat",
        description=f"Linkul public pentru {device.code} · {device.name} a fost regenerat; vechiul QR nu mai este valid.",
        token=link.token,
    )
    db.commit()
    db.refresh(link)
    return public_access_payload(link, base_url)


@router.delete("/{device_id}/public-access")
def revoke_public_access(device_id: int, db: Session = Depends(get_db)):
    begin_inventory_write(db)
    device = get_device_or_404(db, device_id)
    link = (
        db.query(models.DevicePublicLink)
        .filter(models.DevicePublicLink.device_id == device_id)
        .first()
    )
    if link is None or not link.is_active:
        return {"message": "Public access is already disabled"}

    old_token = link.token
    link.is_active = 0
    log_public_access_change(
        db,
        device=device,
        event_type="DEVICE_PUBLIC_ACCESS_REVOKED",
        title="Acces QR revocat",
        description=f"Linkul de vizualizare pentru {device.code} · {device.name} a fost dezactivat.",
        token=old_token,
    )
    db.commit()
    return {"message": "Public access revoked"}


@router.post("/{device_id}/tag", response_model=schemas.DeviceResponse)
def assign_device_tag(device_id: int, payload: schemas.TagAssignRequest, db: Session = Depends(get_db)):
    begin_inventory_write(db)
    device = get_device_or_404(db, device_id)
    old = device.tag
    if old is not None and old.code == payload.tag_code:
        return device

    tag = find_assignable_tag(db, payload.tag_code)
    if old is not None:
        mark_free(old)
        db.flush()
    mark_assigned(tag, device)
    db.flush()
    if old is not None:
        record_tag_change(
            db, device, "DEVICE_TAG_REPLACED", "Etichetă înlocuită",
            f"{device.code} · {device.name}: eticheta {old.code} a fost înlocuită cu {tag.code}; {old.code} este din nou liberă.",
            old.code, tag.code,
        )
    else:
        record_tag_change(
            db, device, "DEVICE_TAG_ASSIGNED", "Etichetă asociată",
            f"Eticheta {tag.code} a fost asociată cu {device.code} · {device.name}.",
            None, tag.code,
        )
    db.commit()
    db.expire(device, ["tag"])
    return device


@router.post("/{device_id}/images", response_model=list[schemas.DeviceImageResponse], status_code=201)
async def upload_device_images(
    device_id: int,
    files: list[UploadFile] = File(...),
    db: Session = Depends(get_db),
):
    await run_in_threadpool(begin_inventory_write, db)
    device = get_device_or_404(db, device_id)

    if not files:
        raise HTTPException(status_code=400, detail="Select at least one image")
    if len(files) > 10:
        raise HTTPException(status_code=400, detail="Maximum 10 images per upload")

    device_dir = UPLOAD_ROOT / str(device_id)
    device_dir.mkdir(parents=True, exist_ok=True)
    if not device_dir.resolve().is_relative_to(UPLOAD_DIR):
        raise HTTPException(status_code=400, detail="Invalid upload directory")
    created: list[models.DeviceImage] = []
    written_paths: list[Path] = []

    try:
        for upload in files:
            data = await upload.read(MAX_IMAGE_SIZE + 1)
            if len(data) > MAX_IMAGE_SIZE:
                raise HTTPException(
                    status_code=413,
                    detail=f"Image '{upload.filename or 'image'}' is larger than 8 MB",
                )

            data, extension, content_type = await run_in_threadpool(sanitize_image, data)
            stored_name = f"{uuid.uuid4().hex}{extension}"
            target = device_dir / stored_name
            written_paths.append(target)
            target.write_bytes(data)

            db_image = models.DeviceImage(
                device_id=device_id,
                stored_name=stored_name,
                original_name=(upload.filename or "image").replace("\\", "/").rsplit("/", 1)[-1][:255] or "image",
                content_type=content_type,
            )
            db.add(db_image)
            db.flush()
            created.append(db_image)

            db.add(
                models.Log(
                    device_id=device.id,
                    action="DEVICE_IMAGE_UPLOADED",
                    new_value=json.dumps(
                        {"image_id": db_image.id, "filename": db_image.original_name},
                        ensure_ascii=False,
                    ),
                )
            )
            record_activity(
                db,
                event_type="DEVICE_IMAGE_UPLOADED",
                category="MEDIA",
                severity="INFO",
                title="Imagine adăugată",
                description=f"A fost adăugată o imagine pentru {device.code} · {device.name}.",
                entity_type="device",
                entity_id=device.id,
                device_id=device.id,
                details={"image_id": db_image.id, "filename": db_image.original_name},
                notify=False,
            )

        db.commit()
        return [image_to_response(image) for image in created]
    except Exception:
        db.rollback()
        for path in written_paths:
            path.unlink(missing_ok=True)
        raise
    finally:
        for upload in files:
            await upload.close()


@router.delete("/{device_id}/images/{image_id}")
def delete_device_image(device_id: int, image_id: int, db: Session = Depends(get_db)):
    begin_inventory_write(db)
    get_device_or_404(db, device_id)
    image = (
        db.query(models.DeviceImage)
        .filter(
            models.DeviceImage.id == image_id,
            models.DeviceImage.device_id == device_id,
        )
        .first()
    )
    if image is None:
        raise HTTPException(status_code=404, detail="Image not found")

    device_dir = (UPLOAD_ROOT / str(device_id)).resolve()
    target = (device_dir / image.stored_name).resolve()
    if target.parent != device_dir or not device_dir.is_relative_to(UPLOAD_DIR):
        raise HTTPException(status_code=400, detail="Invalid stored image path")
    original_name = image.original_name

    db.delete(image)
    db.add(
        models.Log(
            device_id=device_id,
            action="DEVICE_IMAGE_DELETED",
            old_value=json.dumps(
                {"image_id": image_id, "filename": original_name},
                ensure_ascii=False,
            ),
        )
    )
    record_activity(
        db,
        event_type="DEVICE_IMAGE_DELETED",
        category="MEDIA",
        severity="INFO",
        title="Imagine ștearsă",
        description=f"Imaginea {original_name} a fost ștearsă din fișa obiectului #{device_id}.",
        entity_type="device",
        entity_id=device_id,
        device_id=device_id,
        details={"image_id": image_id, "filename": original_name},
        notify=False,
    )
    db.commit()
    target.unlink(missing_ok=True)

    return {"message": "Image deleted"}


@router.put("/{device_id}", response_model=schemas.DeviceResponse)
def update_device(
    device_id: int,
    device_update: schemas.DeviceUpdate,
    db: Session = Depends(get_db),
):
    begin_inventory_write(db)
    db_device = get_device_or_404(db, device_id)

    update_data = device_update.model_dump(exclude_unset=True)
    if "status" in update_data and update_data["status"] is None:
        raise HTTPException(status_code=400, detail="Status cannot be null")
    if "status" in update_data and update_data["status"] is not None:
        update_data["status"] = update_data["status"].upper()
        validate_status(update_data["status"])

    if "location_id" in update_data and update_data["location_id"] is None:
        raise HTTPException(
            status_code=400,
            detail="A tracked device must always have a location",
        )

    active_loan = (
        db.query(models.Loan)
        .filter(
            models.Loan.device_id == device_id,
            models.Loan.status == "ACTIVE",
        )
        .first()
    )
    if active_loan:
        if "status" in update_data and update_data["status"] != "LOANED":
            raise HTTPException(
                status_code=409,
                detail="Device has an active loan. Return it from the Loans section first",
            )
    elif update_data.get("status") == "LOANED":
        raise HTTPException(
            status_code=409,
            detail="Use the Loans section to mark a device as loaned",
        )

    location_id = update_data.get("location_id", db_device.location_id)
    responsible_person_id = update_data.get(
        "responsible_person_id",
        db_device.responsible_person_id,
    )
    validate_references(db, location_id, responsible_person_id)

    if "name" in update_data:
        if update_data["name"] is None or not update_data["name"].strip():
            raise HTTPException(status_code=400, detail="Name cannot be empty")
        update_data["name"] = update_data["name"].strip()
    if "category" in update_data:
        if update_data["category"] is None or not update_data["category"].strip():
            raise HTTPException(status_code=400, detail="Category cannot be empty")
        update_data["category"] = update_data["category"].strip()

    if "serial_number" in update_data and update_data["serial_number"]:
        update_data["serial_number"] = update_data["serial_number"].strip()
    if "description" in update_data and update_data["description"]:
        update_data["description"] = update_data["description"].strip()

    old_value = device_snapshot(db_device)
    old_responsible_id = db_device.responsible_person_id
    old_status = db_device.status
    old_location = get_location(db, db_device.location_id)
    new_location = None
    location_changed = (
        "location_id" in update_data
        and update_data["location_id"] != db_device.location_id
    )
    if location_changed:
        new_location = get_location(db, update_data["location_id"])
        if new_location is None:
            raise HTTPException(status_code=404, detail="Location not found")

    for field, value in update_data.items():
        setattr(db_device, field, value)

    db.flush()

    if location_changed and new_location is not None:
        record_location_change(
            db,
            device_id=db_device.id,
            old_location=old_location,
            new_location=new_location,
            change_type="MOVED",
        )
        db.add(
            models.Log(
                device_id=db_device.id,
                action="DEVICE_LOCATION_CHANGED",
                old_value=json.dumps(
                    {
                        "location_id": old_location.id if old_location else None,
                        "location_name": old_location.name if old_location else None,
                    },
                    ensure_ascii=False,
                ),
                new_value=json.dumps(
                    {"location_id": new_location.id, "location_name": new_location.name},
                    ensure_ascii=False,
                ),
            )
        )
        record_activity(
            db,
            event_type="DEVICE_LOCATION_CHANGED",
            category="TRACKING",
            severity="INFO",
            title="Locație schimbată",
            description=(
                f"{db_device.code} · {db_device.name} a fost mutat din "
                f"{old_location.name if old_location else 'locație necunoscută'} în {new_location.name}."
            ),
            entity_type="device",
            entity_id=db_device.id,
            device_id=db_device.id,
            location_id=new_location.id,
            details={
                "from_location_id": old_location.id if old_location else None,
                "from_location_name": old_location.name if old_location else None,
                "to_location_id": new_location.id,
                "to_location_name": new_location.name,
            },
            notify=True,
        )

    if db_device.responsible_person_id != old_responsible_id:
        old_person = db.get(models.Person, old_responsible_id) if old_responsible_id else None
        new_person = db.get(models.Person, db_device.responsible_person_id) if db_device.responsible_person_id else None
        record_activity(
            db, event_type="DEVICE_RESPONSIBLE_CHANGED", category="INVENTORY",
            severity="INFO", title="Responsabil schimbat",
            description=f"{db_device.code}: {old_person.name if old_person else 'Fără responsabil'} → {new_person.name if new_person else 'Fără responsabil'}.",
            entity_type="device", entity_id=db_device.id, device_id=db_device.id,
            person_id=db_device.responsible_person_id,
            details={"old_responsible_person_id": old_responsible_id, "new_responsible_person_id": db_device.responsible_person_id},
            notify=True,
        )

    if db_device.status != old_status:
        severity = "WARNING" if db_device.status in {"BROKEN", "LOST", "RETIRED"} else "INFO"
        record_activity(
            db,
            event_type="DEVICE_STATUS_CHANGED",
            category="STATUS",
            severity=severity,
            title="Stare obiect modificată",
            description=f"{db_device.code} · {db_device.name}: {old_status} → {db_device.status}.",
            entity_type="device",
            entity_id=db_device.id,
            device_id=db_device.id,
            location_id=db_device.location_id,
            details={"from_status": old_status, "to_status": db_device.status},
            notify=True,
        )

    db.add(
        models.Log(
            device_id=db_device.id,
            action="DEVICE_UPDATED",
            old_value=old_value,
            new_value=device_snapshot(db_device),
        )
    )
    db.commit()
    db.refresh(db_device)
    return db_device


@router.delete("/{device_id}")
def delete_device(device_id: int, db: Session = Depends(get_db)):
    begin_inventory_write(db)
    db_device = get_device_or_404(db, device_id)

    loan_history = (
        db.query(models.Loan)
        .filter(models.Loan.device_id == device_id)
        .first()
    )
    if loan_history:
        raise HTTPException(
            status_code=409,
            detail="Device has loan history and cannot be deleted. Mark it RETIRED instead",
        )

    old_value = device_snapshot(db_device)

    # Remove tracking-only rows and photo metadata before deleting a device.
    # Keep technical history, but detach its foreign key before the deletion.
    db.query(models.Log).filter(models.Log.device_id == device_id).update(
        {models.Log.device_id: None}, synchronize_session=False
    )
    db.query(models.DevicePublicLink).filter(
        models.DevicePublicLink.device_id == device_id
    ).delete(synchronize_session=False)
    db.query(models.DeviceLocationHistory).filter(
        models.DeviceLocationHistory.device_id == device_id
    ).delete(synchronize_session=False)
    db.query(models.DeviceImage).filter(
        models.DeviceImage.device_id == device_id
    ).delete(synchronize_session=False)

    db.add(
        models.Log(
            device_id=None,
            action="DEVICE_DELETED",
            old_value=old_value,
        )
    )
    record_activity(
        db,
        event_type="DEVICE_DELETED",
        category="INVENTORY",
        severity="WARNING",
        title="Obiect șters",
        description=f"{db_device.code} · {db_device.name} a fost șters din inventar.",
        entity_type="device",
        entity_id=db_device.id,
        device_id=db_device.id,
        details={"snapshot": json.loads(old_value)},
        notify=True,
    )
    if db_device.tag is not None:
        # The tag is free again and can be stuck on another item.
        mark_free(db_device.tag)
        db.flush()
    db.delete(db_device)
    db.commit()

    device_dir = (UPLOAD_ROOT / str(device_id)).resolve()
    if device_dir.parent == UPLOAD_ROOT.resolve() and device_dir.is_relative_to(UPLOAD_DIR):
        shutil.rmtree(device_dir, ignore_errors=True)
    return {"message": "Device deleted"}
