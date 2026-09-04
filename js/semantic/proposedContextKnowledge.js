// Offline/curation proposals for new context relations. Runtime never treats PROPOSED as fact.
const ProposedContextKnowledge = (() => {
  const STATUSES = Object.freeze(["APPROVED", "PROPOSED", "REJECTED", "DORMANT"]);

  function create({ source, relation, target, reason = "", requiredEvidence = [], status = "PROPOSED" } = {}) {
    if (!source || !relation || !target) return null;
    return {
      source: String(source),
      relation: String(relation).toUpperCase(),
      target: String(target),
      status: STATUSES.includes(status) ? status : "PROPOSED",
      reason: String(reason).slice(0, 240),
      requiredEvidence: (requiredEvidence || []).slice(0, 8),
      createdAt: Date.now()
    };
  }

  function usable(entry) {
    return entry?.status === "APPROVED";
  }

  class Store {
    constructor() { this.items = []; }
    propose(entry) {
      const item = create(entry);
      if (item) this.items.push(item);
      return item;
    }
    approve(predicate) {
      for (const item of this.items) if (predicate(item) && item.status === "PROPOSED") item.status = "APPROVED";
    }
    reject(predicate) {
      for (const item of this.items) if (predicate(item) && item.status === "PROPOSED") item.status = "REJECTED";
    }
    approved() { return this.items.filter(usable); }
    proposed() { return this.items.filter(item => item.status === "PROPOSED"); }
  }

  return { STATUSES, create, usable, Store };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ProposedContextKnowledge;
