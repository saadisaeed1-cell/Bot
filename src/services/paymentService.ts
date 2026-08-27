import { TronWeb } from 'tronweb';
import { config } from '../config';
import { Prisma } from '@prisma/client';

let tronWeb: TronWeb | null = null;

export function initTronWeb(): TronWeb | null {
  if (!config.tron.escrowPrivateKey) return null;
  tronWeb = new TronWeb({
    fullHost: config.tron.fullNode,
    headers: config.tron.apiKey ? { 'TRON-PRO-API-KEY': config.tron.apiKey } : undefined,
    privateKey: config.tron.escrowPrivateKey,
  });
  return tronWeb;
}

export async function generateUsdtTrc20Address(): Promise<string | null> {
  if (!tronWeb) initTronWeb();
  if (!tronWeb) return null;

  // Create a new random address per deal for better traceability.
  const account = await tronWeb.createAccount();
  return account.address.base58;
}

export async function verifyUsdtTrc20Payment(
  address: string,
  expectedAmount: number,
  txHash?: string
): Promise<{ verified: boolean; amount: number; txHash?: string }> {
  if (!tronWeb) initTronWeb();
  if (!tronWeb) throw new Error('TRON not configured');

  try {
    const contract = await tronWeb.contract().at(config.tron.usdtContract);

    if (txHash) {
      const tx = await tronWeb.trx.getTransaction(txHash);
      const ret = (tx.ret as Array<{ contractRet?: string }>)?.[0];
      if (ret?.contractRet !== 'SUCCESS') return { verified: false, amount: 0 };

      const info = await tronWeb.trx.getTransactionInfo(txHash);
      if (!info || info.receipt?.result !== 'SUCCESS') return { verified: false, amount: 0 };

      // Decode transfer to escrow address
      const logs = info.log ?? [];
      for (const log of logs) {
        if (log.topics && log.topics[0] === 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef') {
          const to = '41' + log.topics[2].slice(-40);
          if (tronWeb.address.fromHex(to) === address) {
            const amount = Number(log.data) / 1e6;
            return {
              verified: amount >= expectedAmount,
              amount,
              txHash,
            };
          }
        }
      }
      return { verified: false, amount: 0 };
    }

    // Fallback: check current balance of the address
    const balance = await contract.balanceOf(address).call();
    const amount = Number(balance.toString()) / 1e6;
    return {
      verified: amount >= expectedAmount,
      amount,
    };
  } catch (err) {
    console.error('verifyUsdtTrc20Payment error:', err);
    return { verified: false, amount: 0 };
  }
}

export async function sweepUsdtTrc20(fromPrivateKey: string, toAddress: string): Promise<string> {
  if (!tronWeb) initTronWeb();
  if (!tronWeb) throw new Error('TRON not configured');

  const localTron = new TronWeb({
    fullHost: config.tron.fullNode,
    headers: config.tron.apiKey ? { 'TRON-PRO-API-KEY': config.tron.apiKey } : undefined,
    privateKey: fromPrivateKey,
  });

  const contract = await localTron.contract().at(config.tron.usdtContract);
  const balance = await contract.balanceOf(localTron.defaultAddress.base58).call();
  const amount = balance.toString();

  const tx = await contract.transfer(toAddress, amount).send();
  return tx as string;
}

// --- TON placeholder helpers ---
// For production use @ton/ton Wallet + TonClient to generate addresses and verify payments.
export function generateTonAddress(): string | null {
  if (!config.ton.escrowMnemonic) return null;
  // Simplified: in real implementation derive a sub-address from mnemonic + deal index.
  return 'EQ' + Buffer.from(Math.random().toString()).toString('base64').slice(0, 40).replace(/[^a-zA-Z0-9]/g, '');
}

export async function verifyTonPayment(
  _address: string,
  _expectedAmount: number,
  _txHash?: string
): Promise<{ verified: boolean; amount: number }> {
  // TODO: integrate TonCenter API or @ton/ton client
  return { verified: false, amount: 0 };
}

export function formatAmount(amount: Prisma.Decimal | number | string): string {
  const value = new Prisma.Decimal(amount);
  return value.toFixed(value.dp() <= 2 ? 2 : 8);
}
