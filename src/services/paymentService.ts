import { Address, beginCell, internal, SendMode, toNano, Cell } from '@ton/core';
import { TonClient, WalletContractV4, JettonMaster } from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { config } from '../config';
import { Prisma } from '@prisma/client';

let client: TonClient | null = null;
let escrowWallet: WalletContractV4 | null = null;
let escrowKeyPair: { publicKey: Buffer; secretKey: Buffer } | null = null;
let escrowAddress: Address | null = null;
let usdtMasterAddress: Address | null = null;

export function isTonConfigured(): boolean {
  return Boolean(config.ton.escrowMnemonic);
}

export function initTonClient(): TonClient | null {
  if (client) return client;
  if (!isTonConfigured()) return null;
  client = new TonClient({
    endpoint: config.ton.endpoint,
    apiKey: config.ton.apiKey,
  });
  return client;
}

export async function initEscrowWallet(): Promise<{
  wallet: WalletContractV4;
  address: Address;
  keyPair: { publicKey: Buffer; secretKey: Buffer };
} | null> {
  if (escrowWallet && escrowAddress && escrowKeyPair) {
    return { wallet: escrowWallet, address: escrowAddress, keyPair: escrowKeyPair };
  }
  if (!isTonConfigured()) return null;

  const keyPair = await mnemonicToPrivateKey(config.ton.escrowMnemonic!.split(' '));
  const wallet = WalletContractV4.create({
    workchain: 0,
    publicKey: keyPair.publicKey,
  });
  escrowWallet = wallet;
  escrowKeyPair = keyPair;
  escrowAddress = wallet.address;
  usdtMasterAddress = Address.parse(config.ton.usdtMaster);

  return { wallet, address: wallet.address, keyPair };
}

export async function getEscrowAddress(): Promise<string | null> {
  const escrow = await initEscrowWallet();
  return escrow?.address.toString({ bounceable: true, urlSafe: true }) ?? null;
}

/**
 * Generates the memo comment a buyer must attach to their deposit.
 * For TON native deposits the comment is the deal code itself.
 * For USDT-jetton deposits the forward_payload must carry the same code.
 */
export function getDepositMemo(dealCode: string): string {
  return dealCode;
}

function toncenterHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (config.ton.apiKey) headers['X-API-Key'] = config.ton.apiKey;
  return headers;
}

async function toncenterGet<T>(path: string): Promise<T | null> {
  const url = `${config.ton.endpoint.replace(/\/jsonRPC$/, '')}${path}`;
  try {
    const res = await fetch(url, { headers: toncenterHeaders() });
    if (!res.ok) {
      console.error(`TonCenter API error ${res.status}: ${await res.text()}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.error('TonCenter fetch error:', err);
    return null;
  }
}

interface TonCenterJettonTransfer {
  query_id: string;
  source: string;
  destination: string;
  amount: string;
  source_wallet: string;
  jetton_master: string;
  transaction_hash: string;
  transaction_lt: string;
  transaction_now: number;
  transaction_aborted: boolean;
  response_destination: string;
  custom_payload: string | null;
  forward_ton_amount: string;
  forward_payload: string | null;
  decoded_forward_payload?: {
    type: string;
    comment?: string;
  } | null;
}

interface TonCenterJettonTransfersResponse {
  jetton_transfers: TonCenterJettonTransfer[];
}

interface TonCenterTransaction {
  hash: string;
  lt: string;
  now: number;
  in_msg?: {
    source?: string;
    destination?: string;
    value?: string;
    message_content?: {
      body?: string;
      decoded?: {
        comment?: string;
      } | null;
    } | null;
  } | null;
}

interface TonCenterTransactionsResponse {
  transactions: TonCenterTransaction[];
}

/**
 * TonCenter v3 returns payloads as base64-encoded single-cell BOCs.
 * Decodes the BOC and extracts a text comment: first 32 bits must be opcode 0,
 * the rest is the comment text. Returns null if not a text comment.
 */
function parseCommentFromBocBase64(bocBase64: string): string | null {
  try {
    const cell = Cell.fromBoc(Buffer.from(bocBase64, 'base64'))[0];
    if (!cell) return null;
    const slice = cell.beginParse();
    if (slice.remainingBits < 32) return null;
    const opcode = slice.loadUint(32);
    if (opcode !== 0) return null; // 0 = text comment opcode
    const bytes = [];
    while (slice.remainingBits >= 8) {
      bytes.push(slice.loadUint(8));
    }
    return Buffer.from(bytes).toString('utf-8').replace(/\0/g, '').trim();
  } catch {
    return null;
  }
}

function parseMemoFromTransfer(transfer: TonCenterJettonTransfer): string | null {
  const decoded = transfer.decoded_forward_payload;
  if (decoded?.type === 'text_comment' && decoded.comment) {
    return decoded.comment.trim();
  }
  if (transfer.forward_payload) {
    return parseCommentFromBocBase64(transfer.forward_payload);
  }
  return null;
}

function parseMemoFromTonTx(tx: TonCenterTransaction): string | null {
  const decoded = tx.in_msg?.message_content?.decoded?.comment;
  if (decoded) return decoded.trim();
  const body = tx.in_msg?.message_content?.body;
  if (body) return parseCommentFromBocBase64(body);
  return null;
}

/**
 * Scans the escrow wallet for recent deposits matching any of the provided memos.
 * Returns a map memo -> { currency, amount, txHash } for verified deposits.
 */
export async function scanEscrowDeposits(
  memos: string[]
): Promise<Record<string, { currency: 'USDT' | 'TON'; amount: number; txHash: string }>> {
  const result: Record<string, { currency: 'USDT' | 'TON'; amount: number; txHash: string }> = {};
  if (!isTonConfigured()) return result;

  const escrow = await initEscrowWallet();
  if (!escrow) return result;
  const escrowRaw = escrow.address.toRawString();

  // 1. Check native TON transfers.
  const tonTxs = await toncenterGet<TonCenterTransactionsResponse>(
    `/api/v3/transactions?account=${escrowRaw}&limit=20`
  );
  if (tonTxs?.transactions) {
    for (const tx of tonTxs.transactions) {
      if (!tx.in_msg?.value) continue;
      const memo = parseMemoFromTonTx(tx);
      if (!memo || !memos.includes(memo)) continue;
      const amount = Number(tx.in_msg.value) / 1e9;
      result[memo] = { currency: 'TON', amount, txHash: tx.hash };
    }
  }

  // 2. Check USDT jetton transfers directed to the escrow wallet.
  const usdtRaw = Address.parse(config.ton.usdtMaster).toRawString();
  const escrowRawFriendly = escrow.address.toString({ bounceable: true, urlSafe: true });
  const jettonTxs = await toncenterGet<TonCenterJettonTransfersResponse>(
    `/api/v3/jetton/transfers?jetton_master=${usdtRaw}&limit=50`
  );
  if (jettonTxs?.jetton_transfers) {
    for (const transfer of jettonTxs.jetton_transfers) {
      if (transfer.transaction_aborted) continue;
      // Match destination by both raw and user-friendly forms (API may return either).
      if (
        transfer.destination !== escrowRaw &&
        transfer.destination !== escrowRawFriendly
      ) {
        continue;
      }
      const memo = parseMemoFromTransfer(transfer);
      if (!memo || !memos.includes(memo)) continue;
      const amount = Number(transfer.amount) / 1e6;
      result[memo] = { currency: 'USDT', amount, txHash: transfer.transaction_hash };
    }
  }

  return result;
}

/**
 * Verifies a single deposit by memo. Convenience wrapper around scanEscrowDeposits.
 */
export async function verifyTonOrUsdtDeposit(
  memo: string,
  expectedAmount: number,
  currency: 'USDT' | 'TON'
): Promise<{ verified: boolean; amount: number; txHash?: string }> {
  const found = await scanEscrowDeposits([memo]);
  const deposit = found[memo];
  if (!deposit || deposit.currency !== currency) {
    return { verified: false, amount: 0 };
  }
  return {
    verified: deposit.amount >= expectedAmount * 0.9999, // small float tolerance
    amount: deposit.amount,
    txHash: deposit.txHash,
  };
}

/**
 * Sends TON from the escrow wallet to a destination address.
 * Returns the txHash of the external message.
 */
export async function sendTon(
  toAddress: string,
  amountTon: number
): Promise<string> {
  const escrow = await initEscrowWallet();
  if (!escrow) throw new Error('TON escrow wallet not configured');
  const tonClient = initTonClient();
  if (!tonClient) throw new Error('TON client not initialized');

  const provider = tonClient.provider(escrow.address, escrow.wallet.init);
  const seqno = await escrow.wallet.getSeqno(provider);

  const transfer = internal({
    to: Address.parse(toAddress),
    value: toNano(amountTon.toFixed(9)),
    bounce: false,
  });

  await escrow.wallet.sendTransfer(provider, {
    seqno,
    secretKey: escrow.keyPair.secretKey,
    messages: [transfer],
    sendMode: SendMode.PAY_GAS_SEPARATELY,
  });

  // Return a synthetic hash; the real txHash requires polling for the outgoing transaction.
  return `pending-${Date.now()}`;
}

/**
 * Sends USDT-jetton from the escrow wallet to a destination address.
 */
export async function sendUsdtJetton(
  toAddress: string,
  amountUsdt: number
): Promise<string> {
  const escrow = await initEscrowWallet();
  if (!escrow) throw new Error('TON escrow wallet not configured');
  const tonClient = initTonClient();
  if (!tonClient) throw new Error('TON client not initialized');
  if (!usdtMasterAddress) throw new Error('USDT master address not initialized');

  const provider = tonClient.provider(escrow.address, escrow.wallet.init);
  const seqno = await escrow.wallet.getSeqno(provider);

  // Determine the escrow's USDT jetton wallet address.
  const master = JettonMaster.create(usdtMasterAddress);
  const jettonWalletAddress = await master.getWalletAddress(provider, escrow.address);

  const amount = BigInt(Math.round(amountUsdt * 1e6));
  const destination = Address.parse(toAddress);

  const forwardPayload = beginCell()
    .storeUint(0, 32) // 0 opcode = text comment
    .storeStringTail('Escrow payout')
    .endCell();

  const messageBody = beginCell()
    .storeUint(0x0f8a7ea5, 32) // jetton transfer opcode
    .storeUint(0, 64) // query id
    .storeCoins(amount)
    .storeAddress(destination)
    .storeAddress(escrow.address) // response destination
    .storeBit(0) // no custom payload
    .storeCoins(toNano('0.02')) // forward ton amount
    .storeBit(1) // forward payload as ref
    .storeRef(forwardPayload)
    .endCell();

  const transfer = internal({
    to: jettonWalletAddress,
    value: toNano('0.1'),
    bounce: true,
    body: messageBody,
  });

  await escrow.wallet.sendTransfer(provider, {
    seqno,
    secretKey: escrow.keyPair.secretKey,
    messages: [transfer],
    sendMode: SendMode.PAY_GAS_SEPARATELY,
  });

  return `pending-${Date.now()}`;
}

export function formatAmount(amount: Prisma.Decimal | number | string): string {
  const value = new Prisma.Decimal(amount);
  return value.toFixed(value.dp() <= 2 ? 2 : 8);
}
