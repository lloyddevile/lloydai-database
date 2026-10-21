function canCreateRole(actor, role) {
  if (actor.role === "owner") return role === "partner" || role === "reseller";
  return actor.role === "partner" && role === "reseller";
}

function canManageAccount(actor, account) {
  if (actor.role === "owner") return account.role === "partner" || account.role === "reseller";
  return actor.role === "partner" && account.role === "reseller" && account.parentId === actor.id;
}

function canDeleteLicense(actor, license, visibleResellerIds) {
  if (actor.role === "owner") return true;
  if (actor.role === "reseller") return license.createdById === actor.id;
  if (actor.role === "partner") {
    return license.createdById === actor.id
      || visibleResellerIds.has(license.createdById)
      || visibleResellerIds.has(license.resellerId);
  }
  return false;
}

module.exports = { canCreateRole, canManageAccount, canDeleteLicense };
