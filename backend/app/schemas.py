from datetime import datetime

import re

from pydantic import BaseModel, ConfigDict, Field, field_validator


class DeviceBase(BaseModel):
    name: str
    category: str
    serial_number: str | None = None
    status: str = "AVAILABLE"
    location_id: int | None = None
    responsible_person_id: int | None = None
    description: str | None = None


def normalize_tag_code(value: str | None) -> str | None:
    # Scanners and keyboards differ in case and may add stray whitespace.
    if value is None:
        return None
    return value.strip().upper() or None


class DeviceCreate(DeviceBase):
    # Every new asset enters the inventory with a known physical location and
    # the pre-printed tag that was stuck on it.
    tag_code: str = Field(min_length=1, max_length=40)
    name: str = Field(max_length=200)
    category: str = Field(max_length=200)
    serial_number: str | None = Field(None, max_length=255)
    status: str = Field("AVAILABLE", max_length=30)
    location_id: int = Field(gt=0)
    responsible_person_id: int | None = Field(None, gt=0)
    description: str | None = Field(None, max_length=10000)

    @field_validator("tag_code")
    @classmethod
    def normalize_tag(cls, value):
        return normalize_tag_code(value)


class DeviceUpdate(BaseModel):
    name: str | None = Field(None, max_length=200)
    category: str | None = Field(None, max_length=200)
    serial_number: str | None = Field(None, max_length=255)
    status: str | None = Field(None, max_length=30)
    location_id: int | None = Field(None, gt=0)
    responsible_person_id: int | None = Field(None, gt=0)
    description: str | None = Field(None, max_length=10000)


class DeviceResponse(DeviceBase):
    id: int
    code: str
    tag_code: str | None = None

    model_config = ConfigDict(from_attributes=True)


class PersonWriteFields(BaseModel):
    email: str | None = Field(None, max_length=254)
    phone: str | None = Field(None, max_length=80)

    @field_validator("email")
    @classmethod
    def validate_email(cls, value):
        if value is None or not value.strip():
            return None
        value = value.strip()
        if not re.fullmatch(r"[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+", value):
            raise ValueError("Enter a valid email address")
        return value


class PersonCreate(PersonWriteFields):
    is_responsible: bool = False
    is_borrower: bool = True
    name: str = Field(max_length=200)


class PersonUpdate(PersonWriteFields):
    is_responsible: bool | None = None
    is_borrower: bool | None = None
    name: str | None = Field(None, max_length=200)
    active: bool | None = None


class PersonResponse(BaseModel):
    is_responsible: bool
    is_borrower: bool
    id: int
    name: str
    email: str | None = None
    phone: str | None = None
    active: bool
    ldap_uid: str | None = None

    model_config = ConfigDict(from_attributes=True)


class DirectorySyncRequest(BaseModel):
    # Defaults to the signed-in LDAP administrator.
    username: str | None = Field(None, max_length=64)
    password: str = Field(min_length=1, max_length=256)


class DirectorySyncIssue(BaseModel):
    person_id: int
    name: str
    reason: str


class DirectorySyncResponse(BaseModel):
    directory_people: int
    created: list[str]
    updated: list[str]
    linked: list[str]
    deactivated: list[str]
    reactivated: list[str]
    skipped: list[DirectorySyncIssue]
    responsible_group: str | None = None
    responsible_group_found: bool = False


class LocationCreate(BaseModel):
    name: str = Field(max_length=200)
    description: str | None = Field(None, max_length=10000)


class LocationUpdate(BaseModel):
    name: str | None = Field(None, max_length=200)
    description: str | None = Field(None, max_length=10000)
    active: bool | None = None


class LocationResponse(BaseModel):
    id: int
    name: str
    description: str | None = None
    active: bool

    model_config = ConfigDict(from_attributes=True)


class LoanCreate(BaseModel):
    device_id: int = Field(gt=0)
    person_id: int = Field(gt=0)


class LoanResponse(BaseModel):
    id: int
    device_id: int
    device_code: str | None = None
    device_name: str | None = None
    person_id: int
    person_name: str | None = None
    loan_date: datetime
    return_date: datetime | None = None
    status: str


class LogResponse(BaseModel):
    id: int
    device_id: int | None = None
    action: str
    old_value: str | None = None
    new_value: str | None = None
    timestamp: datetime

    model_config = ConfigDict(from_attributes=True)


class DeviceImageResponse(BaseModel):
    id: int
    device_id: int
    original_name: str
    content_type: str
    url: str
    uploaded_at: datetime


class DeviceLocationHistoryResponse(BaseModel):
    id: int
    device_id: int
    from_location_id: int | None = None
    from_location_name: str | None = None
    to_location_id: int
    to_location_name: str
    change_type: str
    changed_at: datetime

    model_config = ConfigDict(from_attributes=True)


class DeviceTrackingResponse(BaseModel):
    device: DeviceResponse
    current_location: LocationResponse | None = None
    location_history: list[DeviceLocationHistoryResponse]
    images: list[DeviceImageResponse]


class AuditEventResponse(BaseModel):
    id: int
    event_type: str
    category: str
    severity: str
    entity_type: str | None = None
    entity_id: int | None = None
    device_id: int | None = None
    loan_id: int | None = None
    person_id: int | None = None
    location_id: int | None = None
    title: str
    description: str
    details_json: str | None = None
    occurred_at: datetime

    model_config = ConfigDict(from_attributes=True)


class NotificationResponse(BaseModel):
    id: int
    event_type: str
    severity: str
    title: str
    message: str
    device_id: int | None = None
    loan_id: int | None = None
    is_read: bool
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class TagBatchCreate(BaseModel):
    quantity: int = Field(ge=1, le=240)


class TagAssignRequest(BaseModel):
    tag_code: str = Field(min_length=1, max_length=40)

    @field_validator("tag_code")
    @classmethod
    def normalize_tag(cls, value):
        return normalize_tag_code(value)


class TagDevice(BaseModel):
    id: int
    code: str
    name: str


class TagResponse(BaseModel):
    code: str
    status: str
    batch_id: int
    device: TagDevice | None = None
    assigned_at: datetime | None = None
    voided_at: datetime | None = None


class PrintableTag(BaseModel):
    code: str
    barcode_svg: str


class TagBatchResponse(BaseModel):
    id: int
    quantity: int
    created_at: datetime | None = None
    first_code: str
    last_code: str
    available: int
    assigned: int
    void: int


class TagBatchPrintResponse(TagBatchResponse):
    # Only tags that can still be stuck on an item are (re)printed.
    tags: list[PrintableTag]


class AdminClearDataRequest(BaseModel):
    code: str = Field(min_length=1, max_length=256)


class PublicAccessRequest(BaseModel):
    base_url: str = Field(max_length=500)


class DevicePublicAccessResponse(BaseModel):
    enabled: bool
    public_url: str
    public_path: str
    token: str
    qr_svg: str
    created_at: datetime | None = None
    regenerated_at: datetime | None = None


class PublicDeviceResponse(BaseModel):
    code: str
    name: str
    category: str
    serial_number: str | None = None
    status: str
    description: str | None = None
    location_name: str | None = None
    location_description: str | None = None
    image_url: str | None = None
    image_count: int = 0
    created_at: datetime | None = None
    updated_at: datetime | None = None


class PublicCatalogResponse(BaseModel):
    items: list[PublicDeviceResponse]
    total: int
    filtered_total: int
    page: int
    page_size: int
    categories: list[str]
    locations: list[str]
    statuses: list[str]
