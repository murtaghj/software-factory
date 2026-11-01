-- Fixture application schema v1: orders, inventory, events.
CREATE TABLE stock (sku text PRIMARY KEY, available integer NOT NULL CHECK (available >= 0));
CREATE TABLE orders (id uuid PRIMARY KEY, customer_id text NOT NULL, status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE order_lines (order_id uuid NOT NULL REFERENCES orders(id), sku text NOT NULL, quantity integer NOT NULL, PRIMARY KEY (order_id, sku));
CREATE TABLE reservations (id serial PRIMARY KEY, order_id uuid NOT NULL, sku text NOT NULL REFERENCES stock(sku), quantity integer NOT NULL CHECK (quantity > 0), idempotency_key text NOT NULL, released boolean NOT NULL DEFAULT false);
CREATE TABLE order_events (id serial PRIMARY KEY, order_id uuid NOT NULL, type text NOT NULL, traceparent text NOT NULL, processed_at timestamptz);
CREATE TABLE fulfillment_requests (id serial PRIMARY KEY, order_id uuid NOT NULL, event_id integer NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now());
