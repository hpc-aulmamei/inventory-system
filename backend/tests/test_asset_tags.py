"""Pre-printed tags: batches, assignment on creation, replacement and deletion."""
import os
import sqlite3
import subprocess
import sys

from fastapi.testclient import TestClient

from app import models
from app.database import SessionLocal
from app.main import app
from tests.test_barcode import scan


def location(client):
    return client.post("/locations/", json={"name": "Lab"}).json()


def new_device(client, location_id, **fields):
    return client.post("/devices/", json={"name": "Osciloscop", "category": "Instrumente", "location_id": location_id, **fields})


def batch(client, quantity):
    response = client.post("/tags/batches", json={"quantity": quantity})
    assert response.status_code == 201, response.text
    return response.json()


def test_batches_are_numbered_sequentially_and_print_scannable_barcodes(client):
    first = batch(client, 3)
    assert [tag["code"] for tag in first["tags"]] == ["INV-000001", "INV-000002", "INV-000003"]
    assert (first["first_code"], first["last_code"], first["available"]) == ("INV-000001", "INV-000003", 3)
    assert scan(first["tags"][1]["barcode_svg"]) == [("INV-000002", "Code128")]

    second = batch(client, 2)
    assert (second["first_code"], second["last_code"]) == ("INV-000004", "INV-000005")
    assert [item["id"] for item in client.get("/tags/batches").json()] == [second["id"], first["id"]]

    assert client.post("/tags/batches", json={"quantity": 0}).status_code == 422
    assert client.post("/tags/batches", json={"quantity": 241}).status_code == 422


def test_scanning_a_tag_when_adding_an_item_brings_it_into_the_inventory(client):
    lab = location(client)
    batch(client, 2)

    response = new_device(client, lab["id"], tag_code=" inv-000001 ")
    assert response.status_code == 201, response.text
    device = response.json()
    assert device["tag_code"] == "INV-000001"

    tag = client.get("/tags/inv-000001").json()
    assert tag["status"] == "ASSIGNED"
    assert tag["device"] == {"id": device["id"], "code": device["code"], "name": "Osciloscop"}
    assert client.get("/devices/").json()[0]["tag_code"] == "INV-000001"
    assert client.get("/tags/INV-000002").json() | {"assigned_at": None} == {
        "code": "INV-000002", "status": "AVAILABLE", "batch_id": tag["batch_id"],
        "device": None, "assigned_at": None, "voided_at": None,
    }

    with SessionLocal() as db:
        event = db.query(models.AuditEvent).filter_by(event_type="DEVICE_CREATED").one()
    assert "INV-000001" in event.description


def test_unusable_tags_are_rejected_without_creating_the_item(client):
    lab = location(client)
    batch(client, 2)
    assert new_device(client, lab["id"], tag_code="INV-000001").status_code == 201

    assigned = new_device(client, lab["id"], tag_code="INV-000001")
    assert assigned.status_code == 409 and "DEV-00001" in assigned.json()["detail"]
    assert new_device(client, lab["id"], tag_code="INV-999999").status_code == 404

    # A deleted (lost) tag is gone: its number can no longer be used.
    assert client.delete("/tags/inv-000002").status_code == 200
    assert client.get("/tags/INV-000002").status_code == 404
    assert new_device(client, lab["id"], tag_code="INV-000002").status_code == 404
    missing = client.post("/devices/", json={"name": "Fără etichetă", "category": "X", "location_id": lab["id"]})
    assert missing.status_code == 422
    assert new_device(client, lab["id"], tag_code="   ").status_code == 400
    assert len(client.get("/devices/").json()) == 1
    # A tag on an item is replaced from the item page, not deleted directly.
    on_item = client.delete("/tags/INV-000001")
    assert on_item.status_code == 409 and "DEV-00001" in on_item.json()["detail"]
    assert client.get("/tags/INV-000001").json()["status"] == "ASSIGNED"


def test_a_replaced_tag_is_free_again_and_can_go_on_another_item(client):
    lab = location(client)
    printed = batch(client, 3)
    device = new_device(client, lab["id"], tag_code="INV-000001").json()

    replaced = client.post(f"/devices/{device['id']}/tag", json={"tag_code": "inv-000002"})
    assert replaced.status_code == 200 and replaced.json()["tag_code"] == "INV-000002"
    freed = client.get("/tags/INV-000001").json()
    assert (freed["status"], freed["device"], freed["assigned_at"]) == ("AVAILABLE", None, None)
    # Items keep a tag: there is no way to leave one untagged.
    assert client.delete(f"/devices/{device['id']}/tag").status_code == 405

    summary = client.get(f"/tags/batches/{printed['id']}").json()
    assert [tag["code"] for tag in summary["tags"]] == ["INV-000001", "INV-000003"]
    assert (summary["available"], summary["assigned"]) == (2, 1) and "void" not in summary

    other = new_device(client, lab["id"], tag_code="INV-000001")
    assert other.status_code == 201 and other.json()["tag_code"] == "INV-000001"

    with SessionLocal() as db:
        events = [event.event_type for event in db.query(models.AuditEvent).order_by(models.AuditEvent.id)]
    assert "DEVICE_TAG_REPLACED" in events


def test_items_from_before_tags_can_get_one(client):
    lab = location(client)
    batch(client, 1)
    with SessionLocal() as db:
        db.add(models.Device(id=500, code="DEV-00500", name="Vechi", category="X", status="AVAILABLE", location_id=lab["id"]))
        db.commit()
    assert client.get("/devices/500").json()["tag_code"] is None
    tagged = client.post("/devices/500/tag", json={"tag_code": "INV-000001"})
    assert tagged.status_code == 200 and tagged.json()["tag_code"] == "INV-000001"
    with SessionLocal() as db:
        assert db.query(models.AuditEvent).order_by(models.AuditEvent.id.desc()).first().event_type == "DEVICE_TAG_ASSIGNED"


def test_deleting_an_item_frees_its_tag(client):
    lab = location(client)
    batch(client, 1)
    device = new_device(client, lab["id"], tag_code="INV-000001").json()
    assert client.delete(f"/devices/{device['id']}").status_code == 200
    assert client.get("/tags/INV-000001").json()["status"] == "AVAILABLE"
    assert new_device(client, lab["id"], tag_code="INV-000001").status_code == 201


def test_tags_voided_by_earlier_versions_become_free(tmp_path):
    db = tmp_path / "voided.db"
    env = dict(os.environ, DATABASE_URL="sqlite:///" + str(db))
    start = [sys.executable, "-c", "from app.main import app"]
    subprocess.run(start, env=env, check=True, capture_output=True)
    with sqlite3.connect(db) as con:
        con.execute("INSERT INTO asset_tag_batches (id, quantity, created_at) VALUES (1, 2, CURRENT_TIMESTAMP)")
        con.execute("INSERT INTO asset_tags (id, code, batch_id, status, voided_at) VALUES (1, 'INV-000001', 1, 'VOID', CURRENT_TIMESTAMP)")
        con.execute("INSERT INTO asset_tags (id, code, batch_id, status) VALUES (2, 'INV-000002', 1, 'AVAILABLE')")
    subprocess.run(start, env=env, check=True, capture_output=True)
    with sqlite3.connect(db) as con:
        assert con.execute("SELECT code, status, voided_at FROM asset_tags ORDER BY id").fetchall() == [
            ("INV-000001", "AVAILABLE", None), ("INV-000002", "AVAILABLE", None),
        ]


def test_reset_removes_tags_but_never_reuses_their_numbers(client, monkeypatch):
    monkeypatch.setitem(os.environ, "ADMIN_CLEAR_CODE", "reset-code")
    lab = location(client)
    batch(client, 2)
    new_device(client, lab["id"], tag_code="INV-000001")

    assert client.post("/admin/clear-data", json={"code": "reset-code"}).status_code == 200
    assert client.get("/tags/INV-000001").status_code == 404
    assert client.get("/tags/batches").json() == []
    assert batch(client, 1)["first_code"] == "INV-000003"


def test_tag_endpoints_require_an_admin_session(client):
    printed = batch(client, 1)
    with TestClient(app) as public:
        for method, path in [("GET", "/tags/batches"), ("POST", "/tags/batches"), ("GET", f"/tags/batches/{printed['id']}"),
                             ("GET", "/tags/INV-000001"), ("DELETE", "/tags/INV-000001"),
                             ("POST", "/devices/1/tag")]:
            assert public.request(method, path, json={}).status_code == 401, (method, path)
