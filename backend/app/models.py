from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class Device(Base):
    __tablename__ = "devices"

    id = Column(Integer, primary_key=True, index=True)
    code = Column(String, unique=True, index=True, nullable=False)
    name = Column(String, nullable=False)
    category = Column(String, nullable=False)
    serial_number = Column(String, nullable=True)
    status = Column(String, default="AVAILABLE", nullable=False)
    location_id = Column(Integer, ForeignKey("locations.id"), nullable=True)
    responsible_person_id = Column(Integer, ForeignKey("people.id"), nullable=True)
    description = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    tag = relationship("AssetTag", uselist=False, viewonly=True, lazy="selectin")

    @property
    def tag_code(self) -> str | None:
        return self.tag.code if self.tag else None


class InventoryCounter(Base):
    """Persistent identities also survive deletion and an inventory reset."""

    __tablename__ = "inventory_counters"

    name = Column(String, primary_key=True)
    last_id = Column(Integer, nullable=False, default=0)


class Person(Base):
    __tablename__ = "people"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    email = Column(String, nullable=True)
    phone = Column(String, nullable=True)
    is_responsible = Column(Integer, default=0, nullable=False)
    is_borrower = Column(Integer, default=1, nullable=False)
    active = Column(Integer, default=1, nullable=False)
    # Directory username (FreeIPA uid) for people imported from LDAP; NULL for
    # people added by hand, whom the directory import never changes.
    ldap_uid = Column(String, nullable=True, unique=True, index=True)


class Location(Base):
    __tablename__ = "locations"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False, unique=True)
    description = Column(Text, nullable=True)
    active = Column(Integer, default=1, nullable=False)


class Loan(Base):
    __tablename__ = "loans"

    id = Column(Integer, primary_key=True, index=True)
    device_id = Column(Integer, ForeignKey("devices.id"), nullable=False)
    person_id = Column(Integer, ForeignKey("people.id"), nullable=False)
    loan_date = Column(DateTime(timezone=True), server_default=func.now())
    return_date = Column(DateTime(timezone=True), nullable=True)
    status = Column(String, default="ACTIVE", nullable=False)


class Log(Base):
    __tablename__ = "logs"

    id = Column(Integer, primary_key=True, index=True)
    device_id = Column(Integer, ForeignKey("devices.id"), nullable=True)
    action = Column(String, nullable=False)
    old_value = Column(Text, nullable=True)
    new_value = Column(Text, nullable=True)
    timestamp = Column(DateTime(timezone=True), server_default=func.now())


class DeviceLocationHistory(Base):
    __tablename__ = "device_location_history"

    id = Column(Integer, primary_key=True, index=True)
    device_id = Column(Integer, ForeignKey("devices.id", ondelete="CASCADE"), nullable=False, index=True)

    # Names are intentionally snapshotted too. A tracking entry must stay readable
    # even if a location is renamed later.
    from_location_id = Column(Integer, nullable=True)
    from_location_name = Column(String, nullable=True)
    to_location_id = Column(Integer, nullable=False)
    to_location_name = Column(String, nullable=False)
    change_type = Column(String, default="MOVED", nullable=False)
    changed_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class DeviceImage(Base):
    __tablename__ = "device_images"

    id = Column(Integer, primary_key=True, index=True)
    device_id = Column(Integer, ForeignKey("devices.id", ondelete="CASCADE"), nullable=False, index=True)
    stored_name = Column(String, nullable=False)
    original_name = Column(String, nullable=False)
    content_type = Column(String, nullable=False)
    uploaded_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class AuditEvent(Base):
    __tablename__ = "audit_events"

    id = Column(Integer, primary_key=True, index=True)
    event_type = Column(String, nullable=False, index=True)
    category = Column(String, default="SYSTEM", nullable=False, index=True)
    severity = Column(String, default="INFO", nullable=False)
    entity_type = Column(String, nullable=True)
    entity_id = Column(Integer, nullable=True)
    device_id = Column(Integer, nullable=True, index=True)
    loan_id = Column(Integer, nullable=True, index=True)
    person_id = Column(Integer, nullable=True)
    location_id = Column(Integer, nullable=True)
    title = Column(String, nullable=False)
    description = Column(Text, nullable=False)
    details_json = Column(Text, nullable=True)
    occurred_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False, index=True)


class Notification(Base):
    __tablename__ = "notifications"

    id = Column(Integer, primary_key=True, index=True)
    event_type = Column(String, nullable=False)
    severity = Column(String, default="INFO", nullable=False)
    title = Column(String, nullable=False)
    message = Column(Text, nullable=False)
    device_id = Column(Integer, nullable=True)
    loan_id = Column(Integer, nullable=True)
    is_read = Column(Integer, default=0, nullable=False, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False, index=True)


class DevicePublicLink(Base):
    __tablename__ = "device_public_links"

    id = Column(Integer, primary_key=True, index=True)
    device_id = Column(Integer, ForeignKey("devices.id", ondelete="CASCADE"), nullable=False, unique=True, index=True)
    token = Column(String, nullable=False, unique=True, index=True)
    is_active = Column(Integer, default=1, nullable=False, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    regenerated_at = Column(DateTime(timezone=True), nullable=True)


class AssetTagBatch(Base):
    """A set of pre-printed asset tags, generated together for one print run."""

    __tablename__ = "asset_tag_batches"

    id = Column(Integer, primary_key=True, index=True)
    quantity = Column(Integer, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class AssetTag(Base):
    """A pre-printed sticker. It becomes an item's identity when assigned.

    AVAILABLE: printed, not on an item yet. ASSIGNED: stuck on device_id.
    VOID: lost, damaged, removed or replaced; never assignable again.
    """

    __tablename__ = "asset_tags"

    id = Column(Integer, primary_key=True, index=True)
    code = Column(String, nullable=False, unique=True, index=True)
    batch_id = Column(Integer, ForeignKey("asset_tag_batches.id"), nullable=False, index=True)
    status = Column(String, default="AVAILABLE", nullable=False, index=True)
    # Unique: one sticker per item. Void tags keep no device, so NULLs repeat.
    device_id = Column(Integer, ForeignKey("devices.id"), nullable=True, unique=True)
    assigned_at = Column(DateTime(timezone=True), nullable=True)
    voided_at = Column(DateTime(timezone=True), nullable=True)
