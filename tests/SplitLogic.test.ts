import { describe, it, expect, beforeEach } from "vitest";
import { stringAsciiCV, uintCV, listCV, principalCV, responseErrorCV, responseOkCV, tupleCV, optionalCV } from "@stacks/transactions";

const ERR_UNAUTHORIZED = 100;
const ERR_INVALID_SPLIT = 104;
const ERR_NO_SHARE = 105;
const ERR_NO_SPLIT = 106;
const ERR_INVALID_SHARE_TOTAL = 120;
const ERR_INVALID_SHARE_AMOUNT = 121;
const ERR_BILL_NOT_FOUND = 122;
const ERR_GROUP_NOT_FOUND = 123;
const ERR_MEMBER_NOT_IN_GROUP = 124;
const ERR_SPLIT_ALREADY_EXISTS = 125;
const ERR_SPLIT_NOT_FOUND = 126;
const ERR_INVALID_SPLIT_TYPE = 127;
const ERR_MAX_SHARES_EXCEEDED = 128;
const ERR_TIMESTAMP_INVALID = 129;

interface Share {
  member: string;
  share: number;
}

interface Split {
  billId: number;
  groupId: number;
  splitType: string;
  shares: Share[];
  totalShares: number;
  timestamp: number;
  creator: string;
  approved: boolean;
  approvals: string[];
}

interface SplitHistoryEntry {
  billId: number;
  oldShares: Share[];
  newShares: Share[];
  updater: string;
  timestamp: number;
}

interface Bill {
  groupId: number;
  totalAmount: number;
}

interface Group {
  members: string[];
}

interface Result<T> {
  ok: boolean;
  value: T | number;
}

class BillMock {
  bills: Map<number, Bill> = new Map();
  errors: Map<number, number> = new Map();

  getBill(id: number): Result<Bill> {
    if (this.errors.has(id)) {
      return { ok: false, value: this.errors.get(id)! };
    }
    const bill = this.bills.get(id);
    if (!bill) {
      return { ok: false, value: ERR_BILL_NOT_FOUND };
    }
    return { ok: true, value: bill };
  }
}

class GroupMock {
  groups: Map<number, Group> = new Map();
  errors: Map<number, number> = new Map();

  getGroup(id: number): Result<Group> {
    if (this.errors.has(id)) {
      return { ok: false, value: this.errors.get(id)! };
    }
    const group = this.groups.get(id);
    if (!group) {
      return { ok: false, value: ERR_GROUP_NOT_FOUND };
    }
    return { ok: true, value: group };
  }
}

class SplitLogicMock {
  state: {
    maxSharesPerBill: number;
    defaultSplitType: string;
    authorityContract: string | null;
    splits: Map<number, Split>;
    splitHistory: Map<number, SplitHistoryEntry[]>;
  } = {
    maxSharesPerBill: 20,
    defaultSplitType: "even",
    authorityContract: null,
    splits: new Map(),
    splitHistory: new Map(),
  };
  blockHeight: number = 0;
  caller: string = "ST1TEST";

  constructor() {
    this.reset();
  }

  reset() {
    this.state = {
      maxSharesPerBill: 20,
      defaultSplitType: "even",
      authorityContract: null,
      splits: new Map(),
      splitHistory: new Map(),
    };
    this.blockHeight = 0;
    this.caller = "ST1TEST";
  }

  setAuthorityContract(contractPrincipal: string): Result<boolean> {
    if (this.state.authorityContract !== null) {
      return { ok: false, value: 130 };
    }
    this.state.authorityContract = contractPrincipal;
    return { ok: true, value: true };
  }

  setMaxSharesPerBill(newMax: number): Result<boolean> {
    if (!this.state.authorityContract) {
      return { ok: false, value: 131 };
    }
    this.state.maxSharesPerBill = newMax;
    return { ok: true, value: true };
  }

  getSplit(billId: number): Split | null {
    return this.state.splits.get(billId) || null;
  }

  getSplitHistory(splitId: number): SplitHistoryEntry[] | null {
    return this.state.splitHistory.get(splitId) || null;
  }

  calculateOwe(billId: number, member: string, billMock: BillMock): Result<number> {
    const billResult = billMock.getBill(billId);
    if (!billResult.ok) {
      return { ok: false, value: billResult.value };
    }
    const split = this.getSplit(billId);
    if (!split) {
      return { ok: false, value: ERR_NO_SPLIT };
    }
    const memberShare = split.shares.find(s => s.member === member)?.share || 0;
    if (memberShare === 0) {
      return { ok: false, value: ERR_NO_SHARE };
    }
    const owe = Math.floor((billResult.value.totalAmount * memberShare) / split.totalShares);
    return { ok: true, value: owe };
  }

  splitBillEvenly(billId: number, billMock: BillMock, groupMock: GroupMock): Result<number> {
    const splitType = "even";
    if (!["even", "custom", "weighted"].includes(splitType)) {
      return { ok: false, value: ERR_INVALID_SPLIT_TYPE };
    }
    const billResult = billMock.getBill(billId);
    if (!billResult.ok) {
      return { ok: false, value: billResult.value };
    }
    const groupResult = groupMock.getGroup(billResult.value.groupId);
    if (!groupResult.ok) {
      return { ok: false, value: groupResult.value };
    }
    const members = groupResult.value.members;
    if (!members.includes(this.caller)) {
      return { ok: false, value: ERR_UNAUTHORIZED };
    }
    if (this.getSplit(billId)) {
      return { ok: false, value: ERR_SPLIT_ALREADY_EXISTS };
    }
    const numMembers = members.length;
    const sharePer = Math.floor(10000 / numMembers);
    const shares: Share[] = members.map(m => ({ member: m, share: sharePer }));
    const split: Split = {
      billId,
      groupId: billResult.value.groupId,
      splitType,
      shares,
      totalShares: 10000,
      timestamp: this.blockHeight,
      creator: this.caller,
      approved: false,
      approvals: [this.caller],
    };
    this.state.splits.set(billId, split);
    return { ok: true, value: billId };
  }

  splitBillCustom(billId: number, shares: Share[], billMock: BillMock, groupMock: GroupMock): Result<number> {
    const splitType = "custom";
    if (!["even", "custom", "weighted"].includes(splitType)) {
      return { ok: false, value: ERR_INVALID_SPLIT_TYPE };
    }
    const billResult = billMock.getBill(billId);
    if (!billResult.ok) {
      return { ok: false, value: billResult.value };
    }
    const groupResult = groupMock.getGroup(billResult.value.groupId);
    if (!groupResult.ok) {
      return { ok: false, value: groupResult.value };
    }
    const members = groupResult.value.members;
    if (!members.includes(this.caller)) {
      return { ok: false, value: ERR_UNAUTHORIZED };
    }
    const totalShare = shares.reduce((sum, s) => sum + s.share, 0);
    if (totalShare !== 10000) {
      return { ok: false, value: ERR_INVALID_SHARE_TOTAL };
    }
    if (shares.length !== members.length) {
      return { ok: false, value: ERR_INVALID_SHARE_AMOUNT };
    }
    if (shares.length > this.state.maxSharesPerBill) {
      return { ok: false, value: ERR_MAX_SHARES_EXCEEDED };
    }
    if (this.getSplit(billId)) {
      return { ok: false, value: ERR_SPLIT_ALREADY_EXISTS };
    }
    const split: Split = {
      billId,
      groupId: billResult.value.groupId,
      splitType,
      shares,
      totalShares: 10000,
      timestamp: this.blockHeight,
      creator: this.caller,
      approved: false,
      approvals: [this.caller],
    };
    this.state.splits.set(billId, split);
    return { ok: true, value: billId };
  }

  approveSplit(splitId: number, billMock: BillMock, groupMock: GroupMock): Result<boolean> {
    const split = this.state.splits.get(splitId);
    if (!split) {
      return { ok: false, value: ERR_SPLIT_NOT_FOUND };
    }
    if (split.approved) {
      return { ok: false, value: 132 };
    }
    const billResult = billMock.getBill(split.billId);
    if (!billResult.ok) {
      return { ok: false, value: billResult.value };
    }
    const groupResult = groupMock.getGroup(split.groupId);
    if (!groupResult.ok) {
      return { ok: false, value: groupResult.value };
    }
    const members = groupResult.value.members;
    if (!members.includes(this.caller) || split.approvals.includes(this.caller)) {
      return { ok: false, value: ERR_UNAUTHORIZED };
    }
    const newApprovals = [...split.approvals, this.caller];
    const numApprovals = newApprovals.length;
    const threshold = Math.floor((members.length * 70) / 100);
    if (numApprovals >= threshold) {
      this.state.splits.set(splitId, { ...split, approved: true });
      return { ok: true, value: true };
    } else {
      this.state.splits.set(splitId, { ...split, approvals: newApprovals });
      return { ok: true, value: false };
    }
  }

  updateSplitShares(splitId: number, newShares: Share[], billMock: BillMock, groupMock: GroupMock): Result<boolean> {
    const split = this.state.splits.get(splitId);
    if (!split) {
      return { ok: false, value: ERR_SPLIT_NOT_FOUND };
    }
    if (split.creator !== this.caller) {
      return { ok: false, value: ERR_UNAUTHORIZED };
    }
    const billResult = billMock.getBill(split.billId);
    if (!billResult.ok) {
      return { ok: false, value: billResult.value };
    }
    const groupResult = groupMock.getGroup(split.groupId);
    if (!groupResult.ok) {
      return { ok: false, value: groupResult.value };
    }
    const members = groupResult.value.members;
    const totalShare = newShares.reduce((sum, s) => sum + s.share, 0);
    if (totalShare !== 10000) {
      return { ok: false, value: ERR_INVALID_SHARE_TOTAL };
    }
    if (newShares.length !== members.length) {
      return { ok: false, value: ERR_INVALID_SHARE_AMOUNT };
    }
    if (newShares.length > this.state.maxSharesPerBill) {
      return { ok: false, value: ERR_MAX_SHARES_EXCEEDED };
    }
    const oldShares = split.shares;
    const historyEntry: SplitHistoryEntry = {
      billId: split.billId,
      oldShares,
      newShares,
      updater: this.caller,
      timestamp: this.blockHeight,
    };
    const currentHistory = this.state.splitHistory.get(splitId) || [];
    this.state.splitHistory.set(splitId, [...currentHistory, historyEntry]);
    this.state.splits.set(splitId, { ...split, shares: newShares });
    return { ok: true, value: true };
  }
}

describe("SplitLogic", () => {
  let contract: SplitLogicMock;
  let billMock: BillMock;
  let groupMock: GroupMock;

  beforeEach(() => {
    contract = new SplitLogicMock();
    billMock = new BillMock();
    groupMock = new GroupMock();
    contract.reset();
    billMock.bills.clear();
    billMock.errors.clear();
    groupMock.groups.clear();
    groupMock.errors.clear();
  });

  it("creates an even split successfully", () => {
    contract.setAuthorityContract("ST2TEST");
    billMock.bills.set(1, { groupId: 1, totalAmount: 1000 });
    groupMock.groups.set(1, { members: ["ST1TEST", "ST2TEST"] });
    const result = contract.splitBillEvenly(1, billMock, groupMock);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(1);
    const split = contract.getSplit(1);
    expect(split?.splitType).toBe("even");
    expect(split?.shares).toEqual([
      { member: "ST1TEST", share: 5000 },
      { member: "ST2TEST", share: 5000 }
    ]);
    expect(split?.totalShares).toBe(10000);
    expect(split?.approved).toBe(false);
    expect(split?.approvals).toEqual(["ST1TEST"]);
  });

  it("rejects even split for non-member", () => {
    billMock.bills.set(1, { groupId: 1, totalAmount: 1000 });
    groupMock.groups.set(1, { members: ["ST2TEST"] });
    contract.caller = "ST3TEST";
    const result = contract.splitBillEvenly(1, billMock, groupMock);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_UNAUTHORIZED);
  });

  it("rejects even split if already exists", () => {
    contract.setAuthorityContract("ST2TEST");
    billMock.bills.set(1, { groupId: 1, totalAmount: 1000 });
    groupMock.groups.set(1, { members: ["ST1TEST"] });
    contract.splitBillEvenly(1, billMock, groupMock);
    const result = contract.splitBillEvenly(1, billMock, groupMock);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_SPLIT_ALREADY_EXISTS);
  });

  it("creates a custom split successfully", () => {
    contract.setAuthorityContract("ST2TEST");
    billMock.bills.set(1, { groupId: 1, totalAmount: 1000 });
    groupMock.groups.set(1, { members: ["ST1TEST", "ST2TEST"] });
    const shares: Share[] = [
      { member: "ST1TEST", share: 6000 },
      { member: "ST2TEST", share: 4000 }
    ];
    const result = contract.splitBillCustom(1, shares, billMock, groupMock);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(1);
    const split = contract.getSplit(1);
    expect(split?.shares).toEqual(shares);
  });

  it("rejects custom split with invalid total share", () => {
    contract.setAuthorityContract("ST2TEST");
    billMock.bills.set(1, { groupId: 1, totalAmount: 1000 });
    groupMock.groups.set(1, { members: ["ST1TEST", "ST2TEST"] });
    const shares: Share[] = [
      { member: "ST1TEST", share: 5000 },
      { member: "ST2TEST", share: 5001 }
    ];
    const result = contract.splitBillCustom(1, shares, billMock, groupMock);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_SHARE_TOTAL);
  });

  it("rejects custom split with wrong number of shares", () => {
    contract.setAuthorityContract("ST2TEST");
    billMock.bills.set(1, { groupId: 1, totalAmount: 1000 });
    groupMock.groups.set(1, { members: ["ST1TEST", "ST2TEST", "ST3TEST"] });
    const shares: Share[] = [
      { member: "ST1TEST", share: 5000 },
      { member: "ST2TEST", share: 5000 }
    ];
    const result = contract.splitBillCustom(1, shares, billMock, groupMock);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_SHARE_AMOUNT);
  });

  it("rejects approve by non-member", () => {
    contract.setAuthorityContract("ST2TEST");
    billMock.bills.set(1, { groupId: 1, totalAmount: 1000 });
    groupMock.groups.set(1, { members: ["ST1TEST"] });
    contract.splitBillEvenly(1, billMock, groupMock);
    contract.caller = "ST4TEST";
    const result = contract.approveSplit(1, billMock, groupMock);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_UNAUTHORIZED);
  });

  it("updates split shares successfully", () => {
    contract.setAuthorityContract("ST2TEST");
    billMock.bills.set(1, { groupId: 1, totalAmount: 1000 });
    groupMock.groups.set(1, { members: ["ST1TEST", "ST2TEST"] });
    contract.splitBillEvenly(1, billMock, groupMock);
    const newShares: Share[] = [
      { member: "ST1TEST", share: 7000 },
      { member: "ST2TEST", share: 3000 }
    ];
    const result = contract.updateSplitShares(1, newShares, billMock, groupMock);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    const split = contract.getSplit(1);
    expect(split?.shares).toEqual(newShares);
    const history = contract.getSplitHistory(1);
    expect(history?.length).toBe(1);
    expect(history?.[0].newShares).toEqual(newShares);
  });

  it("rejects update by non-creator", () => {
    contract.setAuthorityContract("ST2TEST");
    billMock.bills.set(1, { groupId: 1, totalAmount: 1000 });
    groupMock.groups.set(1, { members: ["ST1TEST", "ST2TEST"] });
    contract.splitBillEvenly(1, billMock, groupMock);
    contract.caller = "ST3TEST";
    const newShares: Share[] = [
      { member: "ST1TEST", share: 7000 },
      { member: "ST2TEST", share: 3000 }
    ];
    const result = contract.updateSplitShares(1, newShares, billMock, groupMock);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_UNAUTHORIZED);
  });

  it("calculates owe correctly", () => {
    contract.setAuthorityContract("ST2TEST");
    billMock.bills.set(1, { groupId: 1, totalAmount: 1000 });
    groupMock.groups.set(1, { members: ["ST1TEST", "ST2TEST"] });
    contract.splitBillCustom(1, [
      { member: "ST1TEST", share: 6000 },
      { member: "ST2TEST", share: 4000 }
    ], billMock, groupMock);
    const result = contract.calculateOwe(1, "ST1TEST", billMock);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(600);
  });

  it("rejects owe calculation with no share", () => {
    contract.setAuthorityContract("ST2TEST");
    billMock.bills.set(1, { groupId: 1, totalAmount: 1000 });
    groupMock.groups.set(1, { members: ["ST1TEST"] });
    contract.splitBillEvenly(1, billMock, groupMock);
    const result = contract.calculateOwe(1, "ST3TEST", billMock);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_NO_SHARE);
  });

  it("rejects custom split with max shares exceeded", () => {
    contract.setAuthorityContract("ST2TEST");
    contract.setMaxSharesPerBill(1);
    billMock.bills.set(1, { groupId: 1, totalAmount: 1000 });
    groupMock.groups.set(1, { members: ["ST1TEST", "ST2TEST"] });
    const shares: Share[] = [
      { member: "ST1TEST", share: 5000 },
      { member: "ST2TEST", share: 5000 }
    ];
    const result = contract.splitBillCustom(1, shares, billMock, groupMock);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_MAX_SHARES_EXCEEDED);
  });

  it("handles bill not found in split", () => {
    contract.setAuthorityContract("ST2TEST");
    groupMock.groups.set(1, { members: ["ST1TEST"] });
    billMock.errors.set(1, ERR_BILL_NOT_FOUND);
    const result = contract.splitBillEvenly(1, billMock, groupMock);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_BILL_NOT_FOUND);
  });

  it("handles group not found in approve", () => {
    contract.setAuthorityContract("ST2TEST");
    billMock.bills.set(1, { groupId: 1, totalAmount: 1000 });
    groupMock.groups.set(1, { members: ["ST1TEST"] });
    contract.splitBillEvenly(1, billMock, groupMock);
    groupMock.errors.set(1, ERR_GROUP_NOT_FOUND);
    const result = contract.approveSplit(1, billMock, groupMock);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_GROUP_NOT_FOUND);
  });
});