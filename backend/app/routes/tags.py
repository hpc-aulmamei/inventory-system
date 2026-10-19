"""Pre-printed asset tags: printed in batches, assigned when stuck on an item."""

import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import case, func
from sqlalchemy.orm import Session

from app import models, schemas
from app.database import begin_inventory_write, get_db
from app.services.audit import record_activity
from app.services.barcode import code128_svg
from app.services.code_generator import reserve_entity_id

router = APIRouter(prefix="/tags", tags=["Asset tags"])

TAG_PREFIX = "INV"


def format_tag_code(number: int) -> str:
    return f"{TAG_PREFIX}-{number:06d}"


def get_tag_or_404(db: Session, code: str) -> models.AssetTag:
    tag = db.query(models.AssetTag).filter(models.AssetTag.code == code).first()
    if tag is None:
        raise HTTPException(status_code=404, detail=f"Eticheta {code} nu există. Etichetele se generează din pagina Etichete.")
    return tag


def find_assignable_tag(db: Session, code: str) -> models.AssetTag:
    tag = get_tag_or_404(db, code)
    if tag.status == "ASSIGNED":
        device = db.get(models.Device, tag.device_id)
        holder = f"{device.code} · {device.name}" if device else "alt obiect"
        raise HTTPException(status_code=409, detail=f"Eticheta {code} este deja pe {holder}.")
    return tag


def mark_assigned(tag: models.AssetTag, device: models.Device) -> None:
    tag.status = "ASSIGNED"
    tag.device_id = device.id
    tag.assigned_at = datetime.now(timezone.utc)


def mark_free(tag: models.AssetTag) -> None:
    # A tag taken off an item can be stuck on another one.
    tag.status = "AVAILABLE"
    tag.device_id = None
    tag.assigned_at = None


def tag_payload(tag: models.AssetTag, db: Session) -> dict:
    device = db.get(models.Device, tag.device_id) if tag.device_id else None
    return {
        "code": tag.code,
        "status": tag.status,
        "batch_id": tag.batch_id,
        "device": {"id": device.id, "code": device.code, "name": device.name} if device else None,
        "assigned_at": tag.assigned_at,
        "voided_at": tag.voided_at,
    }


def batch_summaries(db: Session, batch_ids: list[int] | None = None) -> list[dict]:
    status = models.AssetTag.status
    query = (
        db.query(
            models.AssetTagBatch,
            func.min(models.AssetTag.code),
            func.max(models.AssetTag.code),
            func.sum(case((status == "AVAILABLE", 1), else_=0)),
            func.sum(case((status == "ASSIGNED", 1), else_=0)),
        )
        .join(models.AssetTag, models.AssetTag.batch_id == models.AssetTagBatch.id)
        .group_by(models.AssetTagBatch.id)
        .order_by(models.AssetTagBatch.id.desc())
    )
    if batch_ids is not None:
        query = query.filter(models.AssetTagBatch.id.in_(batch_ids))
    return [{
        "id": batch.id, "quantity": batch.quantity, "created_at": batch.created_at,
        "first_code": first, "last_code": last,
        "available": available or 0, "assigned": assigned or 0,
    } for batch, first, last, available, assigned in query.all()]


def printable_batch(db: Session, batch_id: int) -> dict:
    summaries = batch_summaries(db, [batch_id])
    if not summaries:
        raise HTTPException(status_code=404, detail="Lotul de etichete nu există.")
    tags = (
        db.query(models.AssetTag)
        .filter(models.AssetTag.batch_id == batch_id, models.AssetTag.status == "AVAILABLE")
        .order_by(models.AssetTag.id)
        .all()
    )
    return {**summaries[0], "tags": [{"code": tag.code, "barcode_svg": code128_svg(tag.code)} for tag in tags]}


@router.get("/batches", response_model=list[schemas.TagBatchResponse])
def get_batches(db: Session = Depends(get_db)):
    return batch_summaries(db)


@router.post("/batches", response_model=schemas.TagBatchPrintResponse, status_code=201)
def create_batch(payload: schemas.TagBatchCreate, db: Session = Depends(get_db)):
    begin_inventory_write(db)
    batch = models.AssetTagBatch(quantity=payload.quantity)
    db.add(batch)
    db.flush()
    for _ in range(payload.quantity):
        # Numbers are never reused, even after deletion or a data reset:
        # stickers printed earlier may still exist on paper.
        number = reserve_entity_id(db, models.AssetTag, "asset_tag", models.AssetTag.id)
        db.add(models.AssetTag(id=number, code=format_tag_code(number), batch_id=batch.id, status="AVAILABLE"))
    db.flush()

    result = printable_batch(db, batch.id)
    record_activity(
        db,
        event_type="TAG_BATCH_CREATED",
        category="INVENTORY",
        title="Lot de etichete generat",
        description=f"{payload.quantity} etichete noi: {result['first_code']} – {result['last_code']}.",
        details={"batch_id": batch.id, "quantity": payload.quantity,
                 "first_code": result["first_code"], "last_code": result["last_code"]},
    )
    db.commit()
    return result


@router.get("/batches/{batch_id}", response_model=schemas.TagBatchPrintResponse)
def get_batch_for_printing(batch_id: int, db: Session = Depends(get_db)):
    return printable_batch(db, batch_id)


@router.get("/{code}", response_model=schemas.TagResponse)
def get_tag(code: str, db: Session = Depends(get_db)):
    return tag_payload(get_tag_or_404(db, schemas.normalize_tag_code(code) or ""), db)


@router.delete("/{code}")
def delete_tag(code: str, db: Session = Depends(get_db)):
    """Remove a lost or damaged free tag. Its number is never printed again."""
    begin_inventory_write(db)
    tag = get_tag_or_404(db, schemas.normalize_tag_code(code) or "")
    if tag.status == "ASSIGNED":
        device = db.get(models.Device, tag.device_id)
        raise HTTPException(
            status_code=409,
            detail=f"Eticheta {tag.code} este pe {device.code if device else 'un obiect'}. Înlocuiește-o din fișa obiectului.",
        )
    db.delete(tag)
    record_activity(
        db,
        event_type="TAG_DELETED",
        category="INVENTORY",
        title="Etichetă ștearsă",
        description=f"Eticheta liberă {tag.code} a fost ștearsă din lista de etichete.",
        details={"tag_code": tag.code, "batch_id": tag.batch_id},
    )
    db.commit()
    return {"message": f"Eticheta {tag.code} a fost ștearsă."}


def record_tag_change(db: Session, device: models.Device, event_type: str, title: str,
                      description: str, old_code: str | None, new_code: str | None) -> None:
    db.add(models.Log(
        device_id=device.id,
        action=event_type,
        old_value=json.dumps({"tag_code": old_code}) if old_code else None,
        new_value=json.dumps({"tag_code": new_code}) if new_code else None,
    ))
    record_activity(
        db,
        event_type=event_type,
        category="INVENTORY",
        title=title,
        description=description,
        entity_type="device",
        entity_id=device.id,
        device_id=device.id,
        details={"old_tag_code": old_code, "new_tag_code": new_code},
    )
