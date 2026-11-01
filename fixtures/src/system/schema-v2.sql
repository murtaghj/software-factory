-- Fixture application schema v2: adds the order audit history used by the cancellation feature.
CREATE TABLE order_audit (id serial PRIMARY KEY, order_id uuid NOT NULL REFERENCES orders(id), actor text NOT NULL, action text NOT NULL, at timestamptz NOT NULL DEFAULT now());
