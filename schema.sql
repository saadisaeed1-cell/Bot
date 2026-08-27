-- PostgreSQL schema for Telegram Escrow Bot
-- Compatible with Neon / AWS RDS / self-hosted PostgreSQL

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TYPE deal_role AS ENUM ('SELLER', 'BUYER');
CREATE TYPE deal_status AS ENUM (
  'PENDING_PARTICIPANT',
  'PENDING_PAYMENT',
  'FUNDS_FROZEN',
  'DELIVERY_PENDING',
  'COMPLETED',
  'DISPUTE',
  'REFUNDED',
  'RELEASED_TO_SELLER',
  'CANCELLED'
);
CREATE TYPE transaction_type AS ENUM (
  'DEPOSIT',
  'ESCROW_HOLD',
  'ESCROW_RELEASE',
  'ESCROW_REFUND',
  'WITHDRAWAL',
  'FEE'
);
CREATE TYPE tx_status AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  telegram_id BIGINT NOT NULL UNIQUE,
  username VARCHAR(255),
  first_name VARCHAR(255),
  last_name VARCHAR(255),
  balance_usdt DECIMAL(18, 8) NOT NULL DEFAULT 0,
  balance_ton DECIMAL(18, 8) NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_telegram_id ON users(telegram_id);

CREATE TABLE deals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  creator_id INTEGER NOT NULL REFERENCES users(id),
  creator_role deal_role NOT NULL DEFAULT 'SELLER',
  participant_id INTEGER REFERENCES users(id),
  amount DECIMAL(18, 8) NOT NULL,
  commission_percent DECIMAL(5, 2) NOT NULL DEFAULT 3,
  currency VARCHAR(10) NOT NULL DEFAULT 'USDT',
  status deal_status NOT NULL DEFAULT 'PENDING_PARTICIPANT',
  description TEXT NOT NULL,
  payment_address VARCHAR(255),
  tx_hash VARCHAR(255) UNIQUE,
  seller_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  buyer_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  dispute_reason TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_deals_status ON deals(status);
CREATE INDEX idx_deals_creator_id ON deals(creator_id);
CREATE INDEX idx_deals_participant_id ON deals(participant_id);

CREATE TABLE transactions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  deal_id UUID REFERENCES deals(id),
  type transaction_type NOT NULL,
  amount DECIMAL(18, 8) NOT NULL,
  currency VARCHAR(10) NOT NULL DEFAULT 'USDT',
  tx_hash VARCHAR(255),
  status tx_status NOT NULL DEFAULT 'COMPLETED',
  description TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_transactions_user_id ON transactions(user_id);
CREATE INDEX idx_transactions_deal_id ON transactions(deal_id);

CREATE TABLE deal_status_logs (
  id SERIAL PRIMARY KEY,
  deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  old_status deal_status NOT NULL,
  new_status deal_status NOT NULL,
  note TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_deal_status_logs_deal_id ON deal_status_logs(deal_id);
