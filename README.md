# Cafeteria Microservices System

A production-style **microservices cafeteria ordering system** built . 
Students can browse menu items, place orders, and track progress in real-time (no polling). Admins can monitor service health/metrics, run chaos testing, recharge wallets, and manage inventory and students.


## Features

### Student App (SPA)

- JWT login
- Menu browsing + item details
- Wallet balance display
- Order placement with **idempotency**
- Live order tracking via **Socket.IO** (no polling)
- Printable order token

### Admin Dashboard

- Service health grid (`/health`)
- Live Prometheus metrics view (`/metrics`)
- Chaos testing: kill services via `/admin/kill`
- Wallet recharge (idempotent)
- Stock upsert/restock + delete items
- Student management (create/list/delete)
- Orders history + wallet transactions history

---

## System Architecture (Summary)

This system is **event-driven**:

1. Student creates an order via Gateway (`POST /orders`)
2. Gateway performs:
   - cache-first stock check (Redis)
   - wallet debit (Identity service)
   - stock decrement (Stock service)
   - stores order in Mongo
   - enqueues kitchen job (BullMQ)
3. Kitchen worker processes asynchronously (3–7s simulation)
4. Kitchen publishes status events to Redis Pub/Sub
5. Notification service forwards events to students over Socket.IO rooms
6. Student UI updates in real-time



## Local Setup 

### Prerequisites

- Docker + Docker Compose installed

### 1) Configure environment variables

This project uses Docker Compose variables: `ADMIN_SECRET`, `JWT_SECRET`.

Create `.env` from the example:

```bash
cp .env.example .env
```

### 2) Run everything

```bash
docker compose up -d --build
```

SOMETIMES, IT MIGHT FAIL DUE TO SERVER PROBLEM OF DOCKER. You might face an error like-

```bash
target stock: failed to solve: failed to fetch oauth token: Post "https://auth.docker.io/token": dial tcp: lookup auth.docker.io: getaddrinfow: This is usually a temporary error during hostname resolution and means that the local server did not receive a response from an authoritative server.
```

In that case, 

1. Open Docker Desktop → Settings → Docker Engine

2. Replace the existing JSON with this:

```bash
{
  "builder": {
    "gc": {
      "defaultKeepStorage": "20GB",
      "enabled": true
    }
  },
  "dns": ["1.1.1.1", "8.8.8.8"],
  "experimental": false
}
```

3. Click Apply & Restart

4. Retry:

```bash
docker compose up -d --build
```
Or, you can manually set IPv4 DNS to your wifi with 1.1.1.1 and 8.8.8.8 from the wifi settings.

This fixes the majority of “auth.docker.io no such host” issues on Windows.

### 3) Open the app

- Frontend: [http://localhost:5173](http://localhost:5173)

### 4) Verify services are up

```bash
docker compose ps
```

Health endpoints:

- Identity: [http://localhost:7001/health](http://localhost:7001/health)
- Gateway: [http://localhost:7002/health](http://localhost:7002/health)
- Stock: [http://localhost:7003/health](http://localhost:7003/health)
- Kitchen: [http://localhost:7004/health](http://localhost:7004/health)
- Notification: [http://localhost:7005/health](http://localhost:7005/health)

Metrics endpoints:

- Identity: [http://localhost:7001/metrics](http://localhost:7001/metrics)
- Gateway: [http://localhost:7002/metrics](http://localhost:7002/metrics)
- Stock: [http://localhost:7003/metrics](http://localhost:7003/metrics)
- Kitchen: [http://localhost:7004/metrics](http://localhost:7004/metrics)
- Notification: [http://localhost:7005/metrics](http://localhost:7005/metrics)

---


### Admin demo

1. Open Admin Dashboard (login as admin in the UI)
2. Show health + metrics updating
3. Trigger chaos test (kill a service) and watch health turn red
4. Recharge a student wallet (repeat with same Idempotency-Key to show idempotency)
5. Upsert/restock items and refresh inventory
6. View orders history & wallet transactions

### Student demo

1. Login as a student
2. Place an order
3. Watch live status updates without polling
4. Print token

> Note: Demo credentials depend on your seeded users. If you modified seeds, update credentials here so judges can log in instantly.

---

## Important Ports

- Frontend: 5173
- Identity: 7001
- Gateway: 7002
- Stock: 7003
- Kitchen: 7004
- Notification: 7005
- MongoDB: 27017
- Redis: 6379

---

## Resetting the Database (if needed)

This removes Mongo volume data (orders/users/items) and starts fresh:

```bash
docker compose down -v
docker compose up -d --build
```

---

## Repository Structure (High Level)

```
prototype2/
├─ docker-compose.yml
├─ .env.example
├─ services/
│  ├─ identity/
│  ├─ gateway/
│  ├─ stock/
│  ├─ kitchen/
│  └─ notification/
└─ frontend/
```


## License

No license 
