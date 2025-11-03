import { describe, it, expect, beforeEach } from "vitest";
import { uintCV, principalCV, responseErrorCV } from "@stacks/transactions";

const ERR_UNAUTHORIZED = 100;
const ERR_INSUFFICIENT_OWE = 101;
const ERR_PARTIAL_PAYMENT_EXCEEDS = 103;
const ERR_BILL_NOT_FOUND = 104;
const ERR_NO_SPLIT_DEFINED = 105;
const ERR_PAYMENT_ALREADY_SETTLED = 106;
const ERR_INVALID_AMOUNT = 107;
const ERR_TRANSFER_FAILED = 108;
const ERR_REFUND_FAILED = 109;
const ERR_INVALID_REFUND_AMOUNT = 110;
const ERR_MAX_PAYMENTS_EXCEEDED = 112;
const ERR_ADMIN_NOT_AUTHORIZED = 115;

type Result<T> = { ok: true; value: T } | { ok: false; value: number };

interface Payment {
  billId: number;
  payer: string;
  amount: number;
  timestamp: number;
  status: string;
  feeDeducted: number;
}

interface BillBalance {
  totalOwed: number;
  totalPaid: number;
  settled: boolean;
  lastUpdated: number;
  groupId: number;
}

interface Refund {
  billId: number;
  payer: string;
  amount: number;
  reason: string;
  timestamp: number;
}

interface PaymentHistoryKey {
  billId: number;
  payer: string;
}

class SplitTraitMock {
  bills = new Map<number, { totalAmount: number }>();
  splits = new Map<number, { member: string; share: number }[]>();

  calculateOwe(billId: number, payer: string): Result<number> {
    const split = this.splits.get(billId);
    if (!split) return { ok: false, value: ERR_NO_SPLIT_DEFINED };
    const shareObj = split.find(s => s.member === payer);
    if (!shareObj) return { ok: false, value: 0 };
    const bill = this.bills.get(billId);
    if (!bill) return { ok: false, value: ERR_BILL_NOT_FOUND };
    const owe = Math.floor(bill.totalAmount * (shareObj.share / 10000));
    return { ok: true, value: owe };
  }

  getSplit(billId: number): Result<{ member: string; share: number }[] | null> {
    return { ok: true, value: this.splits.get(billId) ?? null };
  }
}

class TokenTraitMock {
  balances = new Map<string, number>();
  transfers: Array<{ amount: number; from: string; to: string }> = [];

  getBalance(p: string): Result<number> {
    return { ok: true, value: this.balances.get(p) ?? 0 };
  }

  transfer(amount: number, from: string, to: string): Result<boolean> {
    const fromBal = this.balances.get(from) ?? 0;
    if (fromBal < amount) return { ok: false, value: ERR_TRANSFER_FAILED };
    this.balances.set(from, fromBal - amount);
    this.balances.set(to, (this.balances.get(to) ?? 0) + amount);
    this.transfers.push({ amount, from, to });
    return { ok: true, value: true };
  }
}

class GroupTraitMock {
  groups = new Map<number, { members: string[] }>();

  getGroup(groupId: number): Result<{ members: string[] }> {
    const g = this.groups.get(groupId);
    if (!g) return { ok: false, value: ERR_BILL_NOT_FOUND };
    return { ok: true, value: g };
  }
}

class PaymentTrackerMock {
  state = {
    admin: 'ST1PQHQKV0RJXZHJ1DI0WR516eNwsnKPRUHYQTWJW',
    paymentFee: 10,
    maxPaymentsPerBill: 100,
    settlementThreshold: 95,
    payments: new Map<number, Payment>(),
    billBalances: new Map<number, BillBalance>(),
    paymentHistory: new Map<string, number[]>(),
    refunds: new Map<number, Refund>(),
    blockHeight: 0,
    nextPaymentId: 0,
    payerPaid: new Map<string, number>(),
  };

  caller = 'ST2CY5V39NHDPWSXMW9QDT3XA3GD5Q9GF03KC1R6N';

  splitMock = new SplitTraitMock();
  tokenMock = new TokenTraitMock();
  groupMock = new GroupTraitMock();

  constructor() {
    this.reset();
  }

  reset() {
    this.state = {
      admin: 'ST1PQHQKV0RJXZHJ1DI0WR516eNwsnKPRUHYQTWJW',
      paymentFee: 10,
      maxPaymentsPerBill: 100,
      settlementThreshold: 95,
      payments: new Map(),
      billBalances: new Map(),
      paymentHistory: new Map(),
      refunds: new Map(),
      blockHeight: 0,
      nextPaymentId: 0,
      payerPaid: new Map(),
    };
    this.caller = 'ST2CY5V39NHDPWSXMW9QDT3XA3GD5Q9GF03KC1R6N';
    this.splitMock.bills.clear();
    this.splitMock.splits.clear();
    this.tokenMock.balances.clear();
    this.tokenMock.transfers = [];
    this.groupMock.groups.clear();
    this.tokenMock.balances.set(this.caller, 100_000);
  }

  private fee(amount: number): number {
    return Math.floor((amount * this.state.paymentFee) / 100);
  }

  private updateBalance(billId: number, net: number, add: boolean): Result<boolean> {
    const bal = this.state.billBalances.get(billId);
    if (!bal) return { ok: false, value: ERR_BILL_NOT_FOUND };
    const paid = add ? bal.totalPaid + net : bal.totalPaid - net;
    const ratio = Math.floor((paid * 100) / bal.totalOwed);
    const settled = ratio >= this.state.settlementThreshold;
    this.state.billBalances.set(billId, { ...bal, totalPaid: paid, settled, lastUpdated: this.state.blockHeight });
    return { ok: true, value: true };
  }

  initializeBillBalance(billId: number, totalOwed: number, groupId: number): Result<boolean> {
    if (this.caller !== this.state.admin) return { ok: false, value: ERR_ADMIN_NOT_AUTHORIZED };
    if (totalOwed === 0) return { ok: false, value: ERR_INVALID_AMOUNT };

    const splitRes = this.splitMock.getSplit(billId);
    if (!splitRes.ok || !splitRes.value) return { ok: false, value: ERR_NO_SPLIT_DEFINED };

    const groupRes = this.groupMock.getGroup(groupId);
    if (!groupRes.ok) return { ok: false, value: groupRes.value };

    this.state.billBalances.set(billId, {
      totalOwed,
      totalPaid: 0,
      settled: false,
      lastUpdated: this.state.blockHeight,
      groupId,
    });
    return { ok: true, value: true };
  }

  makePayment(billId: number, amount: number): Result<string> {
    const f = this.fee(amount);
    const net = amount - f;

    const oweRes = this.splitMock.calculateOwe(billId, this.caller);
    if (!oweRes.ok) return oweRes as any;
    if (net > oweRes.value) return { ok: false, value: ERR_INSUFFICIENT_OWE };

    const key = `${billId}-${this.caller}`;
    const history = this.state.paymentHistory.get(key) ?? [];
    if (history.length > 0) return { ok: false, value: ERR_PAYMENT_ALREADY_SETTLED };
    if (amount === 0) return { ok: false, value: ERR_INVALID_AMOUNT };

    const tx = this.tokenMock.transfer(amount, this.caller, 'ST3PF13W7Z0RRM42A8VZDVFQYPFCGZE1MXKSTG6G6');
    if (!tx.ok) return tx as any;

    const upd = this.updateBalance(billId, net, true);
    if (!upd.ok) return upd as any;

    const pid = this.state.nextPaymentId++;
    this.state.payments.set(pid, {
      billId,
      payer: this.caller,
      amount: net,
      timestamp: this.state.blockHeight,
      status: "settled",
      feeDeducted: f,
    });
    this.state.payerPaid.set(key, net);
    this.state.paymentHistory.set(key, [pid]);
    return { ok: true, value: pid.toString() };
  }

  makePartialPayment(billId: number, amount: number): Result<string> {
    const f = this.fee(amount);
    const net = amount - f;

    const oweRes = this.splitMock.calculateOwe(billId, this.caller);
    if (!oweRes.ok) return oweRes as any;

    const key = `${billId}-${this.caller}`;
    const paid = this.state.payerPaid.get(key) ?? 0;
    if (paid + net > oweRes.value) return { ok: false, value: ERR_PARTIAL_PAYMENT_EXCEEDS };
    if (amount === 0) return { ok: false, value: ERR_INVALID_AMOUNT };

    const tx = this.tokenMock.transfer(amount, this.caller, 'ST3PF13W7Z0RRM42A8VZDVFQYPFCGZE1MXKSTG6G6');
    if (!tx.ok) return tx as any;

    const upd = this.updateBalance(billId, net, true);
    if (!upd.ok) return upd as any;

    const pid = this.state.nextPaymentId++;
    this.state.payments.set(pid, {
      billId,
      payer: this.caller,
      amount: net,
      timestamp: this.state.blockHeight,
      status: "partial",
      feeDeducted: f,
    });
    this.state.payerPaid.set(key, paid + net);
    const hist = this.state.paymentHistory.get(key) ?? [];
    const newHist = [...hist, pid];
    if (newHist.length > this.state.maxPaymentsPerBill) return { ok: false, value: ERR_MAX_PAYMENTS_EXCEEDED };
    this.state.paymentHistory.set(key, newHist);
    return { ok: true, value: pid.toString() };
  }

  requestRefund(billId: number, amount: number, reason: string): Result<Result<number>> {
    if (amount === 0) return { ok: false, value: ERR_INVALID_REFUND_AMOUNT };

    const key = `${billId}-${this.caller}`;
    const paid = this.state.payerPaid.get(key) ?? 0;
    if (paid < amount) return { ok: false, value: ERR_INVALID_REFUND_AMOUNT };
    if (!this.state.paymentHistory.has(key)) return { ok: false, value: ERR_UNAUTHORIZED };

    const treasury = 'ST3PF13W7Z0RRM42A8VZDVFQYPFCGZE1MXKSTG6G6';
    const tx = this.tokenMock.transfer(amount, treasury, this.caller);
    if (!tx.ok) return { ok: false, value: ERR_REFUND_FAILED };

    const upd = this.updateBalance(billId, amount, false);
    if (!upd.ok) return upd as any;

    const rid = this.state.refunds.size + 1;
    this.state.refunds.set(rid, { billId, payer: this.caller, amount, reason, timestamp: this.state.blockHeight });
    this.state.payerPaid.set(key, paid - amount);
    return { ok: true, value: rid };
  }

  settleBill(billId: number): Result<boolean> {
    if (this.caller !== this.state.admin) return { ok: false, value: ERR_ADMIN_NOT_AUTHORIZED };
    const bal = this.state.billBalances.get(billId);
    if (!bal) return { ok: false, value: ERR_BILL_NOT_FOUND };
    this.state.billBalances.set(billId, { ...bal, settled: true });
    return { ok: true, value: true };
  }

  setAdmin(a: string) { if (this.caller !== this.state.admin) return { ok: false, value: ERR_ADMIN_NOT_AUTHORIZED }; this.state.admin = a; return { ok: true, value: true }; }
  setPaymentFee(f: number) { if (this.caller !== this.state.admin) return { ok: false, value: ERR_ADMIN_NOT_AUTHORIZED }; this.state.paymentFee = f; return { ok: true, value: true }; }
  setMaxPaymentsPerBill(m: number) { if (this.caller !== this.state.admin) return { ok: false, value: ERR_ADMIN_NOT_AUTHORIZED }; this.state.maxPaymentsPerBill = m; return { ok: true, value: true }; }
  setSettlementThreshold(t: number) { if (this.caller !== this.state.admin) return { ok: false, value: ERR_ADMIN_NOT_AUTHORIZED }; this.state.settlementThreshold = t; return { ok: true, value: true }; }

  getPayment(billId: number, payer: string): Payment | null {
    const key = `${billId}-${payer}`;
    const hist = this.state.paymentHistory.get(key) ?? [];
    if (hist.length === 0) return null;
    return this.state.payments.get(hist[hist.length - 1]) ?? null;
  }

  getBillBalance(billId: number): BillBalance | null {
    return this.state.billBalances.get(billId) ?? null;
  }

  getPaymentHistory(billId: number, payer: string): number[] {
    return this.state.paymentHistory.get(`${billId}-${payer}`) ?? [];
  }

  getRefunds(id: number): Refund | null {
    return this.state.refunds.get(id) ?? null;
  }

  isBillSettled(billId: number): boolean {
    return this.state.billBalances.get(billId)?.settled ?? false;
  }
}

describe("PaymentTracker", () => {
  let c: PaymentTrackerMock;

  beforeEach(() => {
    c = new PaymentTrackerMock();
    c.reset();
  });

  const setupBill = () => {
    c.caller = c.state.admin;
    c.splitMock.bills.set(1, { totalAmount: 1000 });
    c.splitMock.splits.set(1, [{ member: 'ST2CY5V39NHDPWSXMW9QDT3XA3GD5Q9GF03KC1R6N', share: 10000 }]);
    c.groupMock.groups.set(1, { members: ['ST2CY5V39NHDPWSXMW9QDT3XA3GD5Q9GF03KC1R6N'] });
    c.initializeBillBalance(1, 1000, 1);
    c.caller = 'ST2CY5V39NHDPWSXMW9QDT3XA3GD5Q9GF03KC1R6N';
  };

  it("initializes bill balance successfully", () => {
    c.caller = c.state.admin;
    c.splitMock.splits.set(1, [{ member: c.caller, share: 10000 }]);
    c.groupMock.groups.set(1, { members: [c.caller] });
    const r = c.initializeBillBalance(1, 1000, 1);
    expect(r.ok).toBe(true);
    expect(c.getBillBalance(1)?.totalOwed).toBe(1000);
  });

  it("rejects bill balance init by non-admin", () => {
    const r = c.initializeBillBalance(1, 1000, 1);
    expect(r.ok).toBe(false);
    expect(r.value).toBe(ERR_ADMIN_NOT_AUTHORIZED);
  });

  it("rejects init with invalid amount", () => {
    c.caller = c.state.admin;
    const r = c.initializeBillBalance(1, 0, 1);
    expect(r.ok).toBe(false);
    expect(r.value).toBe(ERR_INVALID_AMOUNT);
  });

  it("makes a full payment successfully", () => {
    setupBill();
    const r = c.makePayment(1, 550);
    expect(r.ok).toBe(true);
    const p = c.getPayment(1, c.caller);
    expect(p?.amount).toBe(495);
    expect(p?.status).toBe("settled");
    expect(p?.feeDeducted).toBe(55);
    expect(c.getBillBalance(1)?.totalPaid).toBe(495);
  });

  it("rejects full payment if already settled", () => {
    setupBill();
    c.makePayment(1, 550);
    const r = c.makePayment(1, 100);
    expect(r.ok).toBe(false);
    expect(r.value).toBe(ERR_PAYMENT_ALREADY_SETTLED);
  });

  it("rejects full payment exceeding owe", () => {
    setupBill();
    c.splitMock.splits.set(1, [{ member: c.caller, share: 5000 }]);
    const r = c.makePayment(1, 600);
    expect(r.ok).toBe(false);
    expect(r.value).toBe(ERR_INSUFFICIENT_OWE);
  });

  it("makes partial payment successfully", () => {
    setupBill();
    const r = c.makePartialPayment(1, 300);
    expect(r.ok).toBe(true);
    const p = c.getPayment(1, c.caller);
    expect(p?.amount).toBe(270);
    expect(p?.status).toBe("partial");
    expect(c.getBillBalance(1)?.totalPaid).toBe(270);
  });

  it("requests refund successfully", () => {
    setupBill();
    c.makePayment(1, 550);
    c.tokenMock.balances.set('ST3PF13W7Z0RRM42A8VZDVFQYPFCGZE1MXKSTG6G6', 550);
    const r = c.requestRefund(1, 100, "Overpaid");
    expect(r.ok).toBe(true);
    const ref = c.getRefunds(r.value);
    expect(ref?.amount).toBe(100);
    expect(c.getBillBalance(1)?.totalPaid).toBe(395);
  });

  it("settles bill successfully", () => {
    setupBill();
    c.caller = c.state.admin;
    const r = c.settleBill(1);
    expect(r.ok).toBe(true);
    expect(c.isBillSettled(1)).toBe(true);
  });

  it("rejects settle by non-admin", () => {
    setupBill();
    const r = c.settleBill(1);
    expect(r.ok).toBe(false);
    expect(r.value).toBe(ERR_ADMIN_NOT_AUTHORIZED);
  });

  it("sets admin successfully", () => {
    c.caller = c.state.admin;
    const r = c.setAdmin('STNEW');
    expect(r.ok).toBe(true);
    expect(c.state.admin).toBe('STNEW');
  });

  it("rejects set admin by non-admin", () => {
    const r = c.setAdmin('STNEW');
    expect(r.ok).toBe(false);
    expect(r.value).toBe(ERR_ADMIN_NOT_AUTHORIZED);
  });

  it("sets payment fee successfully", () => { c.caller = c.state.admin; expect(c.setPaymentFee(5).ok).toBe(true); });
  it("sets max payments per bill successfully", () => { c.caller = c.state.admin; expect(c.setMaxPaymentsPerBill(50).ok).toBe(true); });
  it("sets settlement threshold successfully", () => { c.caller = c.state.admin; expect(c.setSettlementThreshold(90).ok).toBe(true); });

  it("calculates settlement based on threshold", () => {
    setupBill();
    c.makePartialPayment(1, 900); // 810 net
    expect(c.getBillBalance(1)?.settled).toBe(false);
    c.makePartialPayment(1, 200); // 180 net → total 990 net → 99%
    expect(c.getBillBalance(1)?.settled).toBe(true);
  });

  it("handles payment history correctly", () => {
    setupBill();
    c.makePartialPayment(1, 100);
    c.makePartialPayment(1, 200);
    expect(c.getPaymentHistory(1, c.caller)).toHaveLength(2);
  });

  it("returns correct payment details", () => {
    setupBill();
    c.makePayment(1, 100);
    const p = c.getPayment(1, c.caller);
    expect(p?.billId).toBe(1);
    expect(p?.payer).toBe(c.caller);
    expect(p?.status).toBe("settled");
  });

  it("returns correct bill balance", () => {
    setupBill();
    const b = c.getBillBalance(1);
    expect(b?.totalOwed).toBe(1000);
    expect(b?.groupId).toBe(1);
  });

  it("checks bill settled status", () => {
    setupBill();
    expect(c.isBillSettled(1)).toBe(false);
    c.caller = c.state.admin;
    c.settleBill(1);
    expect(c.isBillSettled(1)).toBe(true);
  });

  it("rejects refund with invalid amount", () => {
    setupBill();
    const r = c.requestRefund(1, 0, "Test");
    expect(r.ok).toBe(false);
    expect(r.value).toBe(ERR_INVALID_REFUND_AMOUNT);
  });

  it("rejects payment with insufficient token balance", () => {
    c.tokenMock.balances.set(c.caller, 0);
    setupBill();
    const r = c.makePayment(1, 100);
    expect(r.ok).toBe(false);
    expect(r.value).toBe(ERR_TRANSFER_FAILED);
  });
});