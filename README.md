> **Versiune cu catalog public:** vezi [CATALOG_SI_INSTALARE.md](CATALOG_SI_INSTALARE.md) pentru pornire, păstrarea datelor existente și schimbările incluse. Catalogul public se deschide la `/` sau `/catalog`, iar administrarea este separată la `/admin`. Fișele QR au navigare doar către catalog.

# Inventory Management System

A full-stack inventory management application designed to keep track of devices, equipment, components, locations, responsible persons, loans and activity history.

The project provides an administrative interface for managing the inventory and public read-only pages that can be accessed through QR codes attached to physical assets.

---

## Features

### Inventory Management

Administrators can:

* Add new inventory items
* Edit existing items
* Delete items
* View detailed information about each item
* Assign categories
* Store serial numbers
* Track item status
* Assign locations
* Assign responsible persons
* Add descriptions and additional information

Each item receives a unique automatically generated code:

```text
DEV-00001
DEV-00002
DEV-00003
...
```

---

### Admin Authentication

The administration interface is protected by an authentication screen.

Admin authentication is required when accessing the administrative part of the application.

Administrative credentials should not be stored in this README or committed publicly to the repository.

Two sign-in methods are supported, and either can be turned off:

* **LDAP (for example FreeIPA):** administrators sign in with their own directory account. Only members of `LDAP_REQUIRED_GROUP_DN` are admitted, and the journal records who signed in.
* **Local password:** a single shared `ADMIN_PASSWORD`, useful as a fallback when the directory is unreachable. Leave it empty to allow LDAP login only.

LDAP is configured in `backend/.env` (see `backend/.env.example`):

```text
LDAP_SERVER_URI=ldaps://ldap.example.com
LDAP_USER_DN_TEMPLATE=uid={username},cn=users,cn=accounts,dc=example,dc=com
LDAP_REQUIRED_GROUP_DN=cn=inventory-admins,cn=groups,cn=accounts,dc=example,dc=com
# Needed when the server's CA is not in the system trust store:
LDAP_CA_CERT_FILE=/etc/ipa/ca.crt
```

**Importing people from FreeIPA.** On **Persoane**, *Sincronizează din FreeIPA* reads the directory with the administrator's own FreeIPA password (used for that run only, never stored):

* every active account becomes a person who can borrow; members of `LDAP_RESPONSIBLE_GROUP_DN` are also responsible for items;
* names, emails and roles of imported people follow the directory on every run; people added by hand are not changed (one with the same email as a directory account is linked to it instead of duplicated);
* accounts deleted or disabled in FreeIPA are deactivated, except people with an active loan or items in their care, which are reported instead.

The server certificate and host name are always verified. Plain `ldap://` is accepted only with `LDAP_START_TLS=true`. Group membership is checked when someone signs in, so removing a person from the group takes effect at their next sign-in (sessions last at most `ADMIN_SESSION_TTL_SECONDS`).

---

### Locations

Inventory items can be associated with physical locations.

Examples:

```text
Laboratory
Office
Storage Room
Workshop
Classroom
```

Locations can be created and managed separately from devices.

---

### People

The application can store people responsible for inventory items.

Information can include:

* Name
* Email
* Phone number
* Active status

Devices can then be associated with a responsible person.

---

### Activity Logs

Important inventory operations are recorded in the application.

Logs can be used to track actions such as:

```text
DEVICE_CREATED
DEVICE_UPDATED
DEVICE_DELETED
```

This provides a history of changes made to the inventory.

---

### Asset Tags (Barcode Labels)

Labels are printed in advance and an object enters the inventory when a label is stuck on it:

1. **Etichete** page: generate a batch of numbered tags (`INV-000001`, `INV-000002`, …) and print them on A4 adhesive label sheets. Common sheet formats are built in, including 65-label sheets (38.1 × 21.2 mm, 5 × 13); already-used positions on a partly used sheet can be skipped. Print at 100% scale with no margins.
2. Stick a tag on the object.
3. **Adaugă obiect**: scan the tag, fill in the object's details and save. A tag is required: the tag is the object's physical identity, and the app also assigns its internal code (`DEV-00001`).

Tags are Code 128 barcodes. A USB or Bluetooth barcode scanner works as a keyboard:

* scanning a tag in the **Inventar** search opens its object;
* scanning a tag that is not on an object yet opens **Adaugă obiect** with the tag filled in.

A damaged tag is replaced from the object's page (the old tag is voided); objects added before tags existed get theirs the same way. Lost or damaged unused tags can be voided on the **Etichete** page. Tag numbers are never reused, even after deletions or a data reset.

### QR Codes and Public Pages

An object can also get a QR code. Scanning the QR code opens a dedicated public page for that asset.

The public page is designed for normal users and does not provide administrative controls.

Example:

```text
QR Code
   |
   v
/asset/<public-token>
   |
   v
Public asset information
```

This makes it possible to attach a physical label to equipment and instantly access its information using a phone.

---

### Public Asset Pages

Assets can be viewed through a dedicated read-only page without entering the administration interface.

This is useful for:

* QR labels
* Equipment identification
* Asset verification
* Quick access to technical information

User accounts and additional permission levels can be added in future versions.

---

### Protected Database Reset

During development and testing, administrators can clear the application's stored data.

Because this operation is destructive, it requires a separate security code.

This functionality is intended mainly for development and testing and should be carefully restricted in production.

---

### Persistent Storage

Application data is stored in a database and remains available after the backend or frontend is restarted.

The default development database is SQLite.

```text
inventory.db
```

The backend database layer can also be configured through a `DATABASE_URL`.

---

## Tech Stack

### Backend

* Python
* FastAPI
* SQLAlchemy
* Pydantic
* Uvicorn
* SQLite
* python-dotenv
* ldap3 (optional LDAP login)

### Frontend

* React
* Vite
* JavaScript
* HTML
* CSS

### Development Environment

The project can be developed using:

* Ubuntu / WSL
* Windows
* Git
* GitHub
* VS Code

---

## Project Structure

A simplified structure of the project:

```text
inventariere/
│
├── backend/
│   ├── app/
│   │   ├── main.py
│   │   ├── database.py
│   │   ├── models.py
│   │   ├── schemas.py
│   │   │
│   │   ├── routes/
│   │   │   ├── devices.py
│   │   │   ├── people.py
│   │   │   ├── locations.py
│   │   │   ├── loans.py
│   │   │   └── logs.py
│   │   │
│   │   └── services/
│   │       └── code_generator.py
│   │
│   ├── requirements.txt
│   └── inventory.db
│
├── frontend/
│   ├── src/
│   ├── index.html
│   ├── package.json
│   └── ...
│
└── README.md
```

---

# Installation

## 1. Clone the repository

```bash
git clone git@github.com:Brotacus/inventariere.git
cd inventariere
```

If SSH is not configured, HTTPS can also be used:

```bash
git clone https://github.com/Brotacus/inventariere.git
cd inventariere
```

---

# Backend Setup

Move to the backend directory:

```bash
cd backend
```

Create a virtual environment:

```bash
python3 -m venv .venv
```

Activate it:

```bash
source .venv/bin/activate
```

Install dependencies:

```bash
pip install -r requirements.txt
```

Start the API:

```bash
python -m uvicorn app.main:app --reload
```

The backend will normally be available at:

```text
http://127.0.0.1:8000
```

---

## API Documentation

API documentation is disabled by default. For local development only, set
`ENABLE_API_DOCS=true` in `backend/.env` and restart the backend to enable the following URLs.

Swagger UI:

```text
http://127.0.0.1:8000/docs
```

OpenAPI schema:

```text
http://127.0.0.1:8000/openapi.json
```

---

# Frontend Setup

Open another terminal:

```bash
cd ~/inventariere/frontend
```

Install dependencies:

```bash
npm install
```

Start the frontend:

```bash
npm run dev
```

Vite will normally start the application at:

```text
http://localhost:5173
```

Use the URL displayed in the terminal if Vite selects another address or port.

---

# Starting the Entire Application

You normally need two terminals.

### Terminal 1 — Backend

```bash
cd ~/inventariere/backend
source .venv/bin/activate
python -m uvicorn app.main:app --reload
```

### Terminal 2 — Frontend

```bash
cd ~/inventariere/frontend
npm run dev
```

Then open:

```text
http://localhost:5173
```

---

# Database

The default development configuration uses SQLite:

```text
sqlite:///./inventory.db
```

The database contains information related to:

```text
Devices
People
Locations
Loans
Logs
```

The database connection can be changed using the `DATABASE_URL` environment variable.

Example:

```env
DATABASE_URL=sqlite:///./inventory.db
```

---

# API Overview

The backend is organized into multiple FastAPI routers.

Main resource groups include:

```text
/devices
/people
/locations
/loans
/logs
```

Examples:

```http
GET /devices/
POST /devices/
GET /devices/{id}
PUT /devices/{id}
DELETE /devices/{id}
```

---

# Security

Sensitive information should never be committed directly to the repository.

This includes:

```text
Admin passwords
Reset codes
Secret keys
Database credentials
Authentication tokens
```

These values should preferably be stored using environment variables.

Example:

```env
ADMIN_PASSWORD=your-secret-password
ADMIN_CLEAR_CODE=your-secret-reset-code
```

The real `.env` file should be excluded using `.gitignore`.

A template can instead be committed as:

```text
.env.example
```

---

# QR Inventory Workflow

The intended workflow is:

```text
Create asset
     |
     v
Asset receives unique ID/code
     |
     v
Generate QR code / label
     |
     v
Attach label to physical equipment
     |
     v
Scan QR code
     |
     v
Open public asset page
```

This allows physical inventory and the digital database to remain directly connected.

---

# Planned Improvements

Possible future additions include:

* User accounts
* Multiple permission levels
* Admin/User roles
* Improved loan management
* Automatic return tracking
* More advanced audit history
* Search and filtering
* Inventory statistics
* Dashboard analytics
* CSV / Excel export
* Bulk import
* Barcode support
* Printable label templates
* Equipment maintenance history
* Notifications
* PostgreSQL support
* Deployment to a production server

---

# Project Goal

The goal of the project is to provide a simple and expandable inventory platform capable of managing equipment from a central interface while also allowing fast physical identification through QR codes.

The architecture separates the frontend, backend and database layers so that new modules and functionality can be added as the project grows.

---

## Development

Project developed as an inventory management platform using:

```text
React + FastAPI + SQLAlchemy + SQLite
```

Repository:

```text
github.com/Brotacus/inventariere
```

---

## License

This project is currently intended for educational and internal development purposes.

## Roluri pentru persoane responsabile

Actualizarea separă responsabilitatea obiectelor de împrumuturi. Ghidul complet de instalare, migrare și utilizare este în [INSTALARE_ROLURI.md](INSTALARE_ROLURI.md).
