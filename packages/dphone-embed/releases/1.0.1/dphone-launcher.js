const c = /* @__PURE__ */ new Set([
  "dphone.ready",
  "dphone.screenpop",
  "dphone.call.result",
  "dphone.activity",
  "dphone.error"
]);
function h(n) {
  if (!n || typeof n != "object" || Array.isArray(n)) return null;
  const t = n;
  if (t.v !== 1 || typeof t.type != "string" || !c.has(t.type) || t.type === "dphone.activity" && typeof n.interactionId != "string")
    return null;
  if (t.type === "dphone.call.result") {
    const s = n;
    if (typeof s.requestId != "string" || typeof s.status != "string") return null;
  }
  return n;
}
class u {
  constructor(t) {
    this.options = t;
  }
  ready = null;
  activeCall = !1;
  queue = [];
  calls = /* @__PURE__ */ new Map();
  get capabilities() {
    return this.ready?.capabilities ?? null;
  }
  get hasActiveCall() {
    return this.activeCall;
  }
  /** handler ของ `message` บน window ของ host — คืน true เมื่อเป็นข้อความของ dphone นี้ */
  handle(t) {
    const s = this.options.target();
    if (!s || t.origin !== this.options.dphoneOrigin || t.source !== s)
      return !1;
    const e = h(t.data);
    if (!e) return !1;
    switch (e.type) {
      case "dphone.ready":
        this.ready = e, this.options.emit("ready", e);
        for (const i of this.queue.splice(0)) this.post(i);
        break;
      case "dphone.screenpop":
        (e.callState === "ACTIVE" || e.callState === "HELD") && (this.activeCall = !0), e.callState === "ENDED" && (this.activeCall = !1), this.options.emit("screenpop", e);
        break;
      case "dphone.activity":
        this.activeCall = !1, this.activity(e);
        break;
      case "dphone.call.result": {
        this.options.emit("callresult", e);
        const i = this.calls.get(e.requestId);
        i && e.status !== "prefilled" && (this.calls.delete(e.requestId), i.resolve(e));
        break;
      }
      case "dphone.error": {
        this.options.emit("error", e);
        const i = e.requestId ? this.calls.get(e.requestId) : void 0;
        i && e.requestId && (this.calls.delete(e.requestId), i.reject(new Error(e.code)));
        break;
      }
    }
    return !0;
  }
  /** กรอกเบอร์ใน dphone — agent ต้องกดโทรเอง; resolve ด้วยผลสุดท้าย (ไม่ใช่ `prefilled`) */
  call(t, s = {}) {
    const e = this.options.requestId(), i = {
      v: 1,
      type: "dphone.call",
      requestId: e,
      number: t,
      ...s.contactId ? { contactId: s.contactId } : {}
    }, o = new Promise((a, r) => {
      this.calls.set(e, { resolve: a, reject: r });
    });
    return this.ready ? this.post(i) : this.queue.push(i), o;
  }
  async activity(t) {
    const s = this.options.emit("activity", t);
    try {
      await Promise.all(s);
    } catch {
      return;
    }
    this.post({ v: 1, type: "dphone.activity.ack", interactionId: t.interactionId });
  }
  post(t) {
    this.options.target()?.postMessage(t, this.options.dphoneOrigin);
  }
}
const l = "dphone-launcher";
class d extends Event {
  constructor(t, s) {
    super(t), this.detail = s;
  }
  pending = [];
  waitUntil(t) {
    this.pending.push(t);
  }
}
const p = {
  ready: "ready",
  screenpop: "screenpop",
  activity: "activity",
  callresult: "callresult",
  // `error` ของ DOM มีความหมายเดิมอยู่แล้ว (โหลดล้ม) จึงแยกชื่อ
  error: "dphoneerror"
};
function f() {
  try {
    return new URL(import.meta.url).origin;
  } catch {
    return "";
  }
}
class y extends HTMLElement {
  static observedAttributes = ["tenant"];
  iframe = null;
  core = null;
  onMessage = (t) => this.core?.handle(t);
  onBeforeUnload = (t) => {
    this.core?.hasActiveCall && (t.preventDefault(), t.returnValue = "");
  };
  get dphoneOrigin() {
    return this.getAttribute("origin") ?? f();
  }
  get capabilities() {
    return this.core?.capabilities ?? null;
  }
  connectedCallback() {
    this.render(), window.addEventListener("message", this.onMessage), window.addEventListener("beforeunload", this.onBeforeUnload);
  }
  disconnectedCallback() {
    window.removeEventListener("message", this.onMessage), window.removeEventListener("beforeunload", this.onBeforeUnload), this.iframe?.remove(), this.iframe = null, this.core = null;
  }
  attributeChangedCallback() {
    this.isConnected && this.render();
  }
  /** กรอกเบอร์ใน dphone ให้ agent กดโทรเอง — resolve ด้วยผลที่ไม่มี PII */
  call(t, s = {}) {
    return this.core ? this.core.call(t, s) : Promise.reject(new Error("dphone-launcher is not connected"));
  }
  render() {
    const t = this.getAttribute("tenant"), s = this.dphoneOrigin;
    if (this.iframe?.remove(), this.iframe = null, this.core = null, !t || !s) return;
    const e = document.createElement("iframe"), i = new URL("/dphone/embed", s);
    i.searchParams.set("tenant", t), e.src = i.toString(), e.title = this.getAttribute("label") ?? "dphone", e.allow = "microphone; autoplay", e.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-forms"), e.style.width = "100%", e.style.height = "100%", e.style.border = "0", this.style.display || (this.style.display = "block"), this.append(e), this.iframe = e, this.core = new u({
      dphoneOrigin: s,
      target: () => e.contentWindow,
      requestId: () => crypto.randomUUID(),
      emit: (o, a) => {
        const r = new d(p[o], a);
        return this.dispatchEvent(r), r.pending;
      }
    });
  }
}
typeof customElements < "u" && !customElements.get(l) && customElements.define(l, y);
export {
  l as DPHONE_LAUNCHER_TAG,
  y as DphoneLauncherElement,
  d as DphoneLauncherEvent
};
