import { describe, it, expect, beforeEach } from "vitest";
import { ClarityValue, stringUtf8CV, uintCV, principalCV, listCV, someCV, noneCV, tupleCV, booleanCV } from "@stacks/transactions";

const ERR_NOT_AUTHORIZED = 100;
const ERR_GROUP_NOT_FOUND = 102;
const ERR_INVALID_AMOUNT = 103;
const ERR_INVALID_DESCRIPTION = 104;
const ERR_INVALID_DUE_DATE = 105;
const ERR_INVALID_CURRENCY = 106;
const ERR_BILL_NOT_FOUND = 107;
const ERR_BILL_CLOSED = 108;
const ERR_INVALID_CATEGORY = 109;
const ERR_AUTHORITY_NOT_VERIFIED = 110;
const ERR_INVALID_MAX_SPLIT = 111;
const ERR_INVALID_TAX_RATE = 112;
const ERR_MAX_BILLS_EXCEEDED = 113;

interface Bill {
  groupId: number;
  creator: string;
  description: string;
  totalAmount: number;
  createdAt: number;
  dueDate: number;
  currency: string;
  status: boolean;
  category: string;
  maxSplit: number;
  taxRate: number;
}

interface BillMetadata {
  creator: string;
  createdAt: number;
  updatedAt: number;
}

interface Result<T> {
  ok: boolean;
  value: T;
}

interface GroupTrait {
  getGroup(id: number): Result<{ members: string[] }>;
}

class MockGroupContract implements GroupTrait {
  groups: Map<number, { members: string[] }> = new Map();

  getGroup(id: number): Result<{ members: string[] }> {
    const group = this.groups.get(id);
    return group ? { ok: true, value: group } : { ok: false, value: ERR_GROUP_NOT_FOUND };
  }
}

class BillCreatorMock {
  state: {
    billCounter: number;
    authorityContract: string | null;
    creationFee: number;
    maxBills: number;
    bills: Map<number, Bill>;
    billMetadata: Map<number, BillMetadata>;
  } = {
    billCounter: 0,
    authorityContract: null,
    creationFee: 1000,
    maxBills: 10000,
    bills: new Map(),
    billMetadata: new Map(),
  };
  blockHeight: number = 0;
  caller: string = "ST1TEST";
  stxTransfers: Array<{ amount: number; from: string; to: string | null }> = [];
  groupContract: GroupTrait;

  constructor(groupContract: GroupTrait) {
    this.groupContract = groupContract;
    this.reset();
  }

  reset() {
    this.state = {
      billCounter: 0,
      authorityContract: null,
      creationFee: 1000,
      maxBills: 10000,
      bills: new Map(),
      billMetadata: new Map(),
    };
    this.blockHeight = 0;
    this.caller = "ST1TEST";
    this.stxTransfers = [];
  }

  setAuthorityContract(contractPrincipal: string): Result<boolean> {
    if (contractPrincipal === "SP000000000000000000002Q6VF78") {
      return { ok: false, value: false };
    }
    if (this.state.authorityContract !== null) {
      return { ok: false, value: false };
    }
    this.state.authorityContract = contractPrincipal;
    return { ok: true, value: true };
  }

  setCreationFee(newFee: number): Result<boolean> {
    if (!this.state.authorityContract) {
      return { ok: false, value: false };
    }
    this.state.creationFee = newFee;
    return { ok: true, value: true };
  }

  createBill(
    groupId: number,
    description: string,
    totalAmount: number,
    dueDate: number,
    currency: string,
    category: string,
    maxSplit: number,
    taxRate: number
  ): Result<number> {
    if (this.state.billCounter >= this.state.maxBills) {
      return { ok: false, value: ERR_MAX_BILLS_EXCEEDED };
    }
    if (!description || description.length > 100) {
      return { ok: false, value: ERR_INVALID_DESCRIPTION };
    }
    if (totalAmount <= 0) {
      return { ok: false, value: ERR_INVALID_AMOUNT };
    }
    if (dueDate < this.blockHeight) {
      return { ok: false, value: ERR_INVALID_DUE_DATE };
    }
    if (!["STX", "USD", "BTC"].includes(currency)) {
      return { ok: false, value: ERR_INVALID_CURRENCY };
    }
    if (!["dinner", "travel", "event", "other"].includes(category)) {
      return { ok: false, value: ERR_INVALID_CATEGORY };
    }
    if (maxSplit <= 0 || maxSplit > 50) {
      return { ok: false, value: ERR_INVALID_MAX_SPLIT };
    }
    if (taxRate > 20) {
      return { ok: false, value: ERR_INVALID_TAX_RATE };
    }
    if (!this.state.authorityContract) {
      return { ok: false, value: ERR_AUTHORITY_NOT_VERIFIED };
    }

    const groupResult = this.groupContract.getGroup(groupId);
    if (!groupResult.ok) {
      return { ok: false, value: ERR_GROUP_NOT_FOUND };
    }
    if (!groupResult.value.members.includes(this.caller)) {
      return { ok: false, value: ERR_NOT_AUTHORIZED };
    }

    this.stxTransfers.push({ amount: this.state.creationFee, from: this.caller, to: this.state.authorityContract });

    const billId = this.state.billCounter;
    const bill: Bill = {
      groupId,
      creator: this.caller,
      description,
      totalAmount,
      createdAt: this.blockHeight,
      dueDate,
      currency,
      status: true,
      category,
      maxSplit,
      taxRate,
    };
    const metadata: BillMetadata = {
      creator: this.caller,
      createdAt: this.blockHeight,
      updatedAt: this.blockHeight,
    };
    this.state.bills.set(billId, bill);
    this.state.billMetadata.set(billId, metadata);
    this.state.billCounter++;
    return { ok: true, value: billId };
  }

  updateBill(
    billId: number,
    newDescription: string,
    newTotalAmount: number,
    newDueDate: number,
    newCategory: string
  ): Result<boolean> {
    const bill = this.state.bills.get(billId);
    if (!bill) {
      return { ok: false, value: false };
    }
    if (bill.creator !== this.caller) {
      return { ok: false, value: false };
    }
    if (!bill.status) {
      return { ok: false, value: ERR_BILL_CLOSED };
    }
    if (!newDescription || newDescription.length > 100) {
      return { ok: false, value: ERR_INVALID_DESCRIPTION };
    }
    if (newTotalAmount <= 0) {
      return { ok: false, value: ERR_INVALID_AMOUNT };
    }
    if (newDueDate < this.blockHeight) {
      return { ok: false, value: ERR_INVALID_DUE_DATE };
    }
    if (!["dinner", "travel", "event", "other"].includes(newCategory)) {
      return { ok: false, value: ERR_INVALID_CATEGORY };
    }

    const updatedBill: Bill = {
      ...bill,
      description: newDescription,
      totalAmount: newTotalAmount,
      dueDate: newDueDate,
      category: newCategory,
    };
    const updatedMetadata: BillMetadata = {
      ...this.state.billMetadata.get(billId)!,
      updatedAt: this.blockHeight,
    };
    this.state.bills.set(billId, updatedBill);
    this.state.billMetadata.set(billId, updatedMetadata);
    return { ok: true, value: true };
  }

  closeBill(billId: number): Result<boolean> {
    const bill = this.state.bills.get(billId);
    if (!bill) {
      return { ok: false, value: false };
    }
    if (bill.creator !== this.caller) {
      return { ok: false, value: false };
    }
    if (!bill.status) {
      return { ok: false, value: ERR_BILL_CLOSED };
    }

    const updatedBill: Bill = { ...bill, status: false };
    const updatedMetadata: BillMetadata = {
      ...this.state.billMetadata.get(billId)!,
      updatedAt: this.blockHeight,
    };
    this.state.bills.set(billId, updatedBill);
    this.state.billMetadata.set(billId, updatedMetadata);
    return { ok: true, value: true };
  }

  getBill(billId: number): Bill | null {
    return this.state.bills.get(billId) || null;
  }

  getBillMetadata(billId: number): BillMetadata | null {
    return this.state.billMetadata.get(billId) || null;
  }

  getBillCount(): Result<number> {
    return { ok: true, value: this.state.billCounter };
  }
}

describe("BillCreator", () => {
  let contract: BillCreatorMock;
  let groupContract: MockGroupContract;

  beforeEach(() => {
    groupContract = new MockGroupContract();
    contract = new BillCreatorMock(groupContract);
    contract.reset();
    groupContract.groups.set(0, { members: ["ST1TEST", "ST2TEST"] });
  });

  it("creates a bill successfully", () => {
    contract.setAuthorityContract("ST3AUTH");
    const result = contract.createBill(0, "Dinner at Cafe", 1000, 10, "STX", "dinner", 10, 5);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(0);

    const bill = contract.getBill(0);
    expect(bill).toEqual({
      groupId: 0,
      creator: "ST1TEST",
      description: "Dinner at Cafe",
      totalAmount: 1000,
      createdAt: 0,
      dueDate: 10,
      currency: "STX",
      status: true,
      category: "dinner",
      maxSplit: 10,
      taxRate: 5,
    });

    const metadata = contract.getBillMetadata(0);
    expect(metadata).toEqual({
      creator: "ST1TEST",
      createdAt: 0,
      updatedAt: 0,
    });

    expect(contract.stxTransfers).toEqual([{ amount: 1000, from: "ST1TEST", to: "ST3AUTH" }]);
  });

  it("rejects bill creation without authority contract", () => {
    const result = contract.createBill(0, "Dinner", 1000, 10, "STX", "dinner", 10, 5);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_AUTHORITY_NOT_VERIFIED);
  });

  it("rejects bill creation for non-group member", () => {
    contract.setAuthorityContract("ST3AUTH");
    contract.caller = "ST4FAKE";
    const result = contract.createBill(0, "Dinner", 1000, 10, "STX", "dinner", 10, 5);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_NOT_AUTHORIZED);
  });

  it("rejects bill creation with invalid group", () => {
    contract.setAuthorityContract("ST3AUTH");
    const result = contract.createBill(99, "Dinner", 1000, 10, "STX", "dinner", 10, 5);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_GROUP_NOT_FOUND);
  });

  it("rejects bill creation with invalid description", () => {
    contract.setAuthorityContract("ST3AUTH");
    const result = contract.createBill(0, "", 1000, 10, "STX", "dinner", 10, 5);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_DESCRIPTION);
  });

  it("rejects bill creation with invalid amount", () => {
    contract.setAuthorityContract("ST3AUTH");
    const result = contract.createBill(0, "Dinner", 0, 10, "STX", "dinner", 10, 5);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_AMOUNT);
  });

  it("rejects bill creation with invalid due date", () => {
    contract.setAuthorityContract("ST3AUTH");
    contract.blockHeight = 20;
    const result = contract.createBill(0, "Dinner", 1000, 10, "STX", "dinner", 10, 5);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_DUE_DATE);
  });

  it("rejects bill creation with invalid currency", () => {
    contract.setAuthorityContract("ST3AUTH");
    const result = contract.createBill(0, "Dinner", 1000, 10, "EUR", "dinner", 10, 5);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_CURRENCY);
  });

  it("rejects bill creation with invalid category", () => {
    contract.setAuthorityContract("ST3AUTH");
    const result = contract.createBill(0, "Dinner", 1000, 10, "STX", "invalid", 10, 5);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_CATEGORY);
  });

  it("rejects bill creation with invalid max split", () => {
    contract.setAuthorityContract("ST3AUTH");
    const result = contract.createBill(0, "Dinner", 1000, 10, "STX", "dinner", 51, 5);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_MAX_SPLIT);
  });

  it("rejects bill creation with invalid tax rate", () => {
    contract.setAuthorityContract("ST3AUTH");
    const result = contract.createBill(0, "Dinner", 1000, 10, "STX", "dinner", 10, 21);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_TAX_RATE);
  });

  it("rejects bill creation when max bills exceeded", () => {
    contract.setAuthorityContract("ST3AUTH");
    contract.state.maxBills = 1;
    contract.createBill(0, "Dinner", 1000, 10, "STX", "dinner", 10, 5);
    const result = contract.createBill(0, "Lunch", 500, 15, "STX", "dinner", 10, 5);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_MAX_BILLS_EXCEEDED);
  });

  it("updates a bill successfully", () => {
    contract.setAuthorityContract("ST3AUTH");
    contract.createBill(0, "Dinner", 1000, 10, "STX", "dinner", 10, 5);
    const result = contract.updateBill(0, "Updated Dinner", 1500, 20, "event");
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);

    const bill = contract.getBill(0);
    expect(bill).toEqual({
      groupId: 0,
      creator: "ST1TEST",
      description: "Updated Dinner",
      totalAmount: 1500,
      createdAt: 0,
      dueDate: 20,
      currency: "STX",
      status: true,
      category: "event",
      maxSplit: 10,
      taxRate: 5,
    });

    const metadata = contract.getBillMetadata(0);
    expect(metadata?.updatedAt).toBe(0);
  });

  it("rejects update for non-existent bill", () => {
    contract.setAuthorityContract("ST3AUTH");
    const result = contract.updateBill(99, "Updated Dinner", 1500, 20, "event");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(false);
  });

  it("rejects update by non-creator", () => {
    contract.setAuthorityContract("ST3AUTH");
    contract.createBill(0, "Dinner", 1000, 10, "STX", "dinner", 10, 5);
    contract.caller = "ST4FAKE";
    const result = contract.updateBill(0, "Updated Dinner", 1500, 20, "event");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(false);
  });

  it("rejects update for closed bill", () => {
    contract.setAuthorityContract("ST3AUTH");
    contract.createBill(0, "Dinner", 1000, 10, "STX", "dinner", 10, 5);
    contract.closeBill(0);
    const result = contract.updateBill(0, "Updated Dinner", 1500, 20, "event");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_BILL_CLOSED);
  });

  it("closes a bill successfully", () => {
    contract.setAuthorityContract("ST3AUTH");
    contract.createBill(0, "Dinner", 1000, 10, "STX", "dinner", 10, 5);
    const result = contract.closeBill(0);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);

    const bill = contract.getBill(0);
    expect(bill?.status).toBe(false);
    expect(contract.getBillMetadata(0)?.updatedAt).toBe(0);
  });

  it("rejects close for non-existent bill", () => {
    contract.setAuthorityContract("ST3AUTH");
    const result = contract.closeBill(99);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(false);
  });

  it("rejects close by non-creator", () => {
    contract.setAuthorityContract("ST3AUTH");
    contract.createBill(0, "Dinner", 1000, 10, "STX", "dinner", 10, 5);
    contract.caller = "ST4FAKE";
    const result = contract.closeBill(0);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(false);
  });

  it("rejects close for already closed bill", () => {
    contract.setAuthorityContract("ST3AUTH");
    contract.createBill(0, "Dinner", 1000, 10, "STX", "dinner", 10, 5);
    contract.closeBill(0);
    const result = contract.closeBill(0);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_BILL_CLOSED);
  });

  it("sets creation fee successfully", () => {
    contract.setAuthorityContract("ST3AUTH");
    const result = contract.setCreationFee(2000);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    expect(contract.state.creationFee).toBe(2000);
    contract.createBill(0, "Dinner", 1000, 10, "STX", "dinner", 10, 5);
    expect(contract.stxTransfers).toEqual([{ amount: 2000, from: "ST1TEST", to: "ST3AUTH" }]);
  });

  it("returns correct bill count", () => {
    contract.setAuthorityContract("ST3AUTH");
    contract.createBill(0, "Dinner", 1000, 10, "STX", "dinner", 10, 5);
    contract.createBill(0, "Travel", 2000, 20, "USD", "travel", 5, 10);
    const result = contract.getBillCount();
    expect(result.ok).toBe(true);
    expect(result.value).toBe(2);
  });
});