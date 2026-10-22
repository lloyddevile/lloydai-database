const test = require("node:test");
const assert = require("node:assert/strict");
const { canCreateRole, canDeleteLicense, canManageAccount } = require("./permissions");

const owner = { id: "owner-id", role: "owner" };
const partner = { id: "partner-id", role: "partner" };
const childReseller = { id: "reseller-id", role: "reseller", parentId: partner.id };
const otherReseller = { id: "other-reseller-id", role: "reseller", parentId: "other-partner-id" };
const user = { id: "user-id", role: "user" };

test("role creation follows the owner and partner hierarchy", () => {
  assert.equal(canCreateRole(owner, "partner"), true);
  assert.equal(canCreateRole(owner, "reseller"), true);
  assert.equal(canCreateRole(partner, "reseller"), true);
  assert.equal(canCreateRole(partner, "partner"), false);
  assert.equal(canCreateRole(owner, "user"), false);
  assert.equal(canCreateRole(childReseller, "reseller"), false);
});

test("account deletion is limited to owners and a partner's own resellers", () => {
  assert.equal(canManageAccount(owner, partner), true);
  assert.equal(canManageAccount(owner, otherReseller), true);
  assert.equal(canManageAccount(owner, user), true);
  assert.equal(canManageAccount(partner, childReseller), true);
  assert.equal(canManageAccount(partner, user), false);
  assert.equal(canManageAccount(partner, otherReseller), false);
});

test("license deletion follows creator and reseller visibility", () => {
  const visibleResellerIds = new Set([childReseller.id]);
  assert.equal(canDeleteLicense(owner, { createdById: otherReseller.id, resellerId: otherReseller.id }, visibleResellerIds), true);
  assert.equal(canDeleteLicense(partner, { createdById: childReseller.id, resellerId: childReseller.id }, visibleResellerIds), true);
  assert.equal(canDeleteLicense(partner, { createdById: otherReseller.id, resellerId: otherReseller.id }, visibleResellerIds), false);
  assert.equal(canDeleteLicense(childReseller, { createdById: childReseller.id, resellerId: childReseller.id }, visibleResellerIds), true);
  assert.equal(canDeleteLicense(childReseller, { createdById: partner.id, resellerId: childReseller.id }, visibleResellerIds), false);
});
