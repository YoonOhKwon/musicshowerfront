class SessionGuard {
  constructor() {
    this.currentId = 0;
  }

  next() {
    this.currentId += 1;
    return this.currentId;
  }

  isCurrent(sessionId) {
    return Number(sessionId) === this.currentId;
  }
}

if (typeof module !== "undefined" && module.exports) module.exports = SessionGuard;
