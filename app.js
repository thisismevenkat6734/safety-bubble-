/* Safety Bubble — static web app baseline.
 * Real emergency calling/SMS dispatch and background tracking require platform/provider integrations.
 */
(() => {
  "use strict";
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const QUOTES = [
    "You deserve to feel safe, heard, and supported.",
    "Being prepared is an act of self-respect.",
    "Your voice matters. Your boundaries matter. You matter.",
    "Courage can be quiet: asking for help is strength.",
    "You are allowed to choose safety, every single time.",
    "Trust your instincts, make a plan, and reach out when you need to.",
    "You do not have to face a difficult moment alone.",
    "Small steps toward safety are still powerful steps."
  ];
  const state = {
    user: null, contacts: [], timeline: [], journey: null, map: null, mapMarker: null,
    location: null, bleDevice: null, bleServer: null, battery: null, theme: "dark",
    phoneConfirmation: null, recaptcha: null, currentQuote: 0, activeSosId: null
  };
  let auth, db, analytics = null;
  const serverTimestamp = () => firebase.firestore.FieldValue.serverTimestamp();
  const dateNow = () => new Date().toISOString();
  const escapeHtml = (s = "") => String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  function toast(message, kind = "info") {
    const node = document.createElement("div"); node.className = `toast ${kind}`; node.textContent = message;
    $("#toastRegion").append(node); setTimeout(() => node.remove(), 4200);
  }
  function setBusy(button, busy, text) {
    if (!button) return;
    if (busy) { button.dataset.oldText = button.textContent; button.disabled = true; if (text) button.textContent = text; }
    else { button.disabled = false; if (button.dataset.oldText) button.textContent = button.dataset.oldText; delete button.dataset.oldText; }
  }
  function friendlyError(error) {
    const code = error?.code || "";
    const messages = {
      "auth/email-already-in-use":"An account with this email already exists.",
      "auth/invalid-email":"Please enter a valid email address.",
      "auth/weak-password":"Choose a password with at least 6 characters.",
      "auth/user-not-found":"No account was found. Create an account first.",
      "auth/wrong-password":"The password is incorrect.",
      "auth/invalid-credential":"Email or password is incorrect.",
      "auth/too-many-requests":"Too many attempts. Please wait and try again.",
      "auth/popup-closed-by-user":"The sign-in popup was closed.",
      "auth/unauthorized-domain":"Add this website host to Firebase Authentication → Settings → Authorized domains.",
      "permission-denied":"Firestore denied this action. Check that the supplied security rules are published.",
      "unavailable":"The service is temporarily unavailable. Check your connection."
    };
    return messages[code] || error?.message || "Something went wrong. Please try again.";
  }
  function requireUser() { if (!state.user) throw new Error("Please sign in first."); return state.user; }
  function showAuth() { $("#authView").classList.remove("hidden"); $("#appView").classList.add("hidden"); }
  function showApp(user) {
    $("#authView").classList.add("hidden"); $("#appView").classList.remove("hidden");
    const display = user.displayName || user.email?.split("@")[0] || user.phoneNumber || "Safety member";
    $("#userName").textContent = display; $("#userEmail").textContent = user.email || user.phoneNumber || "Signed in securely";
    $("#userAvatar").textContent = display.trim().charAt(0).toUpperCase() || "S";
    $("#settingsAccount").textContent = user.email || user.phoneNumber || "Signed-in account";
    $("#dateLabel").textContent = new Intl.DateTimeFormat(undefined, {weekday:"long", month:"long", day:"numeric"}).format(new Date()).toUpperCase();
    refreshAll().catch(e => toast(friendlyError(e), "error"));
  }
  async function ensureProfile(user) {
    const ref = db.collection("profiles").doc(user.uid);
    const snap = await ref.get();
    if (!snap.exists) await ref.set({
      uid: user.uid, displayName: user.displayName || "", email: user.email || "",
      phoneNumber: user.phoneNumber || "", photoURL: user.photoURL || "",
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(), role: "user", schemaVersion: 1
    }, {merge:true});
    else await ref.set({displayName:user.displayName || snap.data().displayName || "", email:user.email || snap.data().email || "", phoneNumber:user.phoneNumber || snap.data().phoneNumber || "", updatedAt:serverTimestamp()}, {merge:true});
  }
  async function refreshAll() {
    if (!state.user) return;
    try { await ensureProfile(state.user); } catch (e) { console.warn("Profile initialization:", e); }
    await Promise.allSettled([loadContacts(), loadTimeline(), loadJourney(), loadVolunteerProfile()]);
    renderDashboard();
  }
  function collectionForContacts() { return db.collection("profiles").doc(requireUser().uid).collection("trustedContacts"); }
  async function loadContacts() {
    const snap = await collectionForContacts().orderBy("createdAt", "desc").get();
    state.contacts = snap.docs.map(d => ({id:d.id, ...d.data()})); renderContacts(); renderDashboard();
  }
  async function addContact(data) {
    const phone = data.phone.replace(/[^\d+]/g, "");
    if (phone.length < 7 || phone.length > 18) throw new Error("Enter a valid contact phone number.");
    await collectionForContacts().add({...data, phone, createdAt:serverTimestamp(), updatedAt:serverTimestamp()});
    await recordEvent("Trusted contact added", `Added ${data.name} to your trusted circle.`, "contact");
    await loadContacts(); toast("Trusted contact saved.", "success");
  }
  async function removeContact(id) {
    const contact = state.contacts.find(c => c.id === id);
    if (!contact || !confirm(`Remove ${contact.name} from your trusted circle?`)) return;
    await collectionForContacts().doc(id).delete();
    await recordEvent("Trusted contact removed", `Removed ${contact.name} from your trusted circle.`, "contact");
    await loadContacts(); toast("Contact removed.");
  }
  function renderContacts() {
    const list = $("#contactsList"), empty = $("#contactsEmpty");
    list.innerHTML = state.contacts.map(c => `<article class="panel glass contact-card"><div class="contact-avatar">${escapeHtml((c.name||"?").charAt(0).toUpperCase())}</div><div class="contact-main"><strong>${escapeHtml(c.name)}</strong><small>${escapeHtml(c.relation || "Trusted contact")} · ${escapeHtml(c.phone)}</small>${c.email?`<small>${escapeHtml(c.email)}</small>`:""}</div><div class="contact-actions"><a href="tel:${encodeURIComponent(c.phone)}" aria-label="Call ${escapeHtml(c.name)}">☎</a><button type="button" data-remove-contact="${escapeHtml(c.id)}" aria-label="Remove ${escapeHtml(c.name)}">×</button></div></article>`).join("");
    empty.classList.toggle("hidden", state.contacts.length > 0);
  }
  async function recordEvent(title, description, type = "activity", extra = {}) {
    const user = requireUser();
    const ref = db.collection("profiles").doc(user.uid).collection("timeline").doc();
    const data = {id:ref.id, uid:user.uid, title, description, type, createdAt:serverTimestamp(), clientCreatedAt:dateNow(), ...extra};
    await ref.set(data);
    state.timeline.unshift({...data, createdAt:{toDate:()=>new Date(data.clientCreatedAt)}});
    state.timeline = state.timeline.slice(0, 100);
    renderTimeline(); renderDashboard();
  }
  async function loadTimeline() {
    const snap = await db.collection("profiles").doc(requireUser().uid).collection("timeline").orderBy("createdAt", "desc").limit(100).get();
    state.timeline = snap.docs.map(d => ({id:d.id, ...d.data()})); renderTimeline(); renderDashboard();
  }
  function toDate(value) { if (!value) return null; if (typeof value.toDate === "function") return value.toDate(); const d = new Date(value); return Number.isNaN(d.getTime()) ? null : d; }
  function renderTimeline() {
    const root = $("#timelineList");
    if (!state.timeline.length) { root.innerHTML = `<div class="timeline-empty"><div class="empty-icon">◷</div><h3>No activity yet</h3><p>Your account's activity will appear here as you use the app.</p></div>`; return; }
    const icon = type => ({sos:"!",contact:"♡",journey:"↗",device:"⌁",volunteer:"✧",location:"⌖"}[type] || "◷");
    root.innerHTML = state.timeline.map(e => { const d = toDate(e.createdAt) || toDate(e.clientCreatedAt); return `<div class="timeline-item"><div class="timeline-icon">${icon(e.type)}</div><div><strong>${escapeHtml(e.title || "Safety activity")}</strong><p>${escapeHtml(e.description || "")}</p><time>${d ? escapeHtml(d.toLocaleString()) : "Recently"}</time></div></div>`; }).join("");
  }
  async function loadJourney() {
    const snap = await db.collection("profiles").doc(requireUser().uid).collection("journeys").where("status","==","active").limit(1).get();
    state.journey = snap.empty ? null : {id:snap.docs[0].id, ...snap.docs[0].data()}; renderJourney();
  }
  function renderJourney() {
    const root = $("#currentJourney");
    if (!state.journey) { root.innerHTML = `<div class="empty-icon">↗</div><h3>No active journey</h3><p class="muted">Create a journey plan to see it here.</p>`; return; }
    const eta = state.journey.eta ? new Date(state.journey.eta) : null;
    root.innerHTML = `<div class="journey-card"><p class="eyebrow">ACTIVE JOURNEY</p><strong>${escapeHtml(state.journey.destination)}</strong><p>Expected arrival: ${eta ? escapeHtml(eta.toLocaleString()) : "Not set"}</p><p>${escapeHtml(state.journey.note || "No extra note.")}</p><button class="btn secondary" id="finishJourney">Mark as arrived</button><button class="btn secondary" id="shareJourney">Share journey details</button></div>`;
    $("#finishJourney").addEventListener("click", finishJourney);
    $("#shareJourney").addEventListener("click", shareJourney);
  }
  async function finishJourney() {
    if (!state.journey) return;
    await db.collection("profiles").doc(requireUser().uid).collection("journeys").doc(state.journey.id).update({status:"completed", completedAt:serverTimestamp(), updatedAt:serverTimestamp()});
    await recordEvent("Journey completed", `Marked arrival at ${state.journey.destination}.`, "journey");
    state.journey = null; renderJourney(); toast("Journey marked as completed.", "success");
  }
  async function shareJourney() {
    if (!state.journey) return;
    const message = `Safety Bubble journey plan\nDestination: ${state.journey.destination}\nExpected arrival: ${state.journey.eta || "Not set"}\nNote: ${state.journey.note || "None"}`;
    if (navigator.share) { try { await navigator.share({title:"My safe journey",text:message}); } catch(e) { if(e.name!=="AbortError") toast("Share was not completed."); } }
    else { await copyText(message); toast("Journey details copied. Paste them into your messaging app.", "success"); }
  }
  function renderDashboard() {
    $("#contactCount").textContent = `${state.contacts.length} contact${state.contacts.length===1?"":"s"}`;
    $("#activityCount").textContent = `${state.timeline.length} event${state.timeline.length===1?"":"s"}`;
    $("#deviceStatus").textContent = state.bleDevice?.gatt?.connected ? "Connected" : "Not connected";
    $("#locationStatus").textContent = state.location ? "Available" : "Not shared";
    $("#locationDetail").textContent = state.location ? `${state.location.lat.toFixed(4)}, ${state.location.lng.toFixed(4)}` : "Enable when you need it";
  }
  async function getCurrentPosition() {
    if (!navigator.geolocation) throw new Error("This browser does not support geolocation.");
    return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(
      p => resolve({lat:p.coords.latitude, lng:p.coords.longitude, accuracy:p.coords.accuracy, timestamp:p.timestamp}),
      e => reject(new Error(({1:"Location permission was denied.",2:"Your location is unavailable. Try outdoors.",3:"Location request timed out. Try again."})[e.code] || e.message)),
      {enableHighAccuracy:true, timeout:15000, maximumAge:10000}
    ));
  }
  async function locateUser() {
    const button = $("#locateMe"); setBusy(button,true,"Finding location…");
    try {
      const pos = await getCurrentPosition(); state.location = pos; initMap(pos); renderDashboard();
      await recordEvent("Location checked", `Location permission used; reported accuracy approximately ${Math.round(pos.accuracy)} metres.`, "location");
      toast("Your location was found. It has not been sent to contacts.", "success");
    } catch(e) { toast(e.message, "error"); }
    finally { setBusy(button,false); }
  }
  function initMap(pos = null) {
    if (!window.L || !$("#safetyMap")) return;
    if (!state.map) {
      state.map = L.map("safetyMap", {zoomControl:true}).setView(pos ? [pos.lat,pos.lng] : [16.5062,80.648], pos ? 15 : 5);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {maxZoom:19, attribution:'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'}).addTo(state.map);
    }
    if (pos) {
      state.map.setView([pos.lat,pos.lng], 16);
      if (state.mapMarker) state.map.removeLayer(state.mapMarker);
      state.mapMarker = L.marker([pos.lat,pos.lng]).addTo(state.map).bindPopup("Your current location (shown only in this browser).").openPopup();
      setTimeout(()=>state.map?.invalidateSize(),150);
    }
  }
  function searchNearby(kind) {
    if (!state.location) { toast("Find your location first, then search nearby.", "error"); return; }
    const queries = {police:"police station",hospital:"hospital",pharmacy:"pharmacy",safe:"public place community centre"};
    const q = `${queries[kind]} near ${state.location.lat},${state.location.lng}`;
    window.open(`https://www.openstreetmap.org/search?query=${encodeURIComponent(q)}`, "_blank", "noopener,noreferrer");
  }
  async function activateSOS() {
    const dialog = $("#sosDialog"); $("#sosStatus").textContent = "Attempting to get your current location…"; $("#sosLocation").textContent = ""; $("#sosContactActions").innerHTML = "";
    dialog.showModal(); let pos = null;
    try { pos = await getCurrentPosition(); state.location = pos; renderDashboard(); $("#sosStatus").textContent = `Location acquired (approx. ${Math.round(pos.accuracy)} m accuracy). Review and choose how to contact help.`; $("#sosLocation").innerHTML = `Coordinates: <strong>${pos.lat.toFixed(6)}, ${pos.lng.toFixed(6)}</strong><br><a href="https://www.google.com/maps?q=${pos.lat},${pos.lng}" target="_blank" rel="noopener">Open location map ↗</a>`; }
    catch(e) { $("#sosStatus").textContent = `Could not get location: ${e.message} You can still call emergency services or contact a trusted person.`; }
    let eventId = null;
    try {
      const ref = db.collection("sosEvents").doc(); eventId = ref.id; state.activeSosId = eventId;
      await ref.set({eventId, uid:requireUser().uid, status:"created", location:pos ? {lat:pos.lat,lng:pos.lng,accuracy:pos.accuracy} : null, createdAt:serverTimestamp(), clientCreatedAt:dateNow(), source:"web-button", userAgent:navigator.userAgent.slice(0,240)});
      await recordEvent("SOS prepared", pos ? "Emergency SOS prepared with current location. Contact sharing still requires your action." : "Emergency SOS prepared without location.", "sos", {sosEventId:eventId});
    } catch(e) { toast(`SOS event could not be saved: ${friendlyError(e)}`, "error"); }
    const msg = `EMERGENCY — I may need help.\nMy name: ${state.user.displayName || state.user.email || state.user.phoneNumber || "Safety Bubble user"}\n${pos ? `Location: https://maps.google.com/?q=${pos.lat},${pos.lng}\nAccuracy: approximately ${Math.round(pos.accuracy)} m\n` : "Location could not be obtained.\n"}Please contact me or emergency services.`;
    $("#sosContactActions").innerHTML = state.contacts.length ? state.contacts.map(c => `<a class="sos-contact-btn" href="sms:${encodeURIComponent(c.phone)}?body=${encodeURIComponent(msg)}"><span><strong>${escapeHtml(c.name)}</strong><small>${escapeHtml(c.phone)} · Opens SMS app</small></span><span>↗</span></a><a class="sos-contact-btn" href="https://wa.me/${encodeURIComponent(c.phone.replace(/\D/g,""))}?text=${encodeURIComponent(msg)}" target="_blank" rel="noopener"><span><strong>WhatsApp · ${escapeHtml(c.name)}</strong><small>Opens WhatsApp; you must send it</small></span><span>↗</span></a>`).join("") : `<p class="muted">No trusted contacts yet. You can still call emergency services.</p><button class="btn secondary" id="sosAddContact">Add a trusted contact</button>`;
    $("#sosAddContact")?.addEventListener("click", () => { dialog.close(); $("#contactDialog").showModal(); });
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); }
    catch { const ta=document.createElement("textarea"); ta.value=text; document.body.append(ta); ta.select(); document.execCommand("copy"); ta.remove(); }
  }
  async function connectBle() {
    if (!navigator.bluetooth) { toast("Web Bluetooth is unavailable here. Try a compatible Chromium browser on HTTPS, or use a real BLE test peripheral.", "error"); return; }
    try {
      const device = await navigator.bluetooth.requestDevice({acceptAllDevices:true, optionalServices:["battery_service","device_information"]});
      state.bleDevice = device; $("#bleName").textContent = device.name || "Unnamed BLE device"; $("#bleDeviceName").textContent = device.name || "Unnamed"; $("#bleDeviceId").textContent = device.id || "Not exposed"; $("#bleConnection").textContent = "Connecting…"; $("#bleLog").textContent = `Selected device: ${device.name || "Unnamed"}\nID: ${device.id || "Not exposed"}`;
      device.addEventListener("gattserverdisconnected", onBleDisconnected);
      const server = await device.gatt.connect(); state.bleServer = server; $("#bleConnection").textContent = "Connected"; $("#blePill").textContent = "BLE status · Connected"; $("#connectBle").classList.add("hidden"); $("#disconnectBle").classList.remove("hidden");
      const services = await server.getPrimaryServices(); $("#bleServices").textContent = services.map(s=>s.uuid).join(", ") || "No readable services";
      let lines = [`Connected to ${device.name || "BLE device"}`, `Device ID: ${device.id || "Not exposed"}`, `Services: ${services.length}`];
      for (const service of services) {
        if (service.uuid === "battery_service") {
          try { const ch = await service.getCharacteristic("battery_level"); const val = await ch.readValue(); const level = val.getUint8(0); $("#bleBattery").textContent = `${level}%`; lines.push(`Battery level: ${level}%`); } catch(e) { lines.push(`Battery service unavailable: ${e.message}`); }
        }
        if (service.uuid === "device_information") {
          for (const uuid of ["manufacturer_name_string","model_number_string","serial_number_string","firmware_revision_string","hardware_revision_string","software_revision_string"]) {
            try { const ch=await service.getCharacteristic(uuid); const val=await ch.readValue(); const txt=new TextDecoder().decode(val); lines.push(`${uuid}: ${txt}`); } catch {}
          }
        }
      }
      $("#bleLog").textContent = lines.join("\n"); await recordEvent("Bluetooth device connected", `Connected to ${device.name || "unnamed BLE device"}.`, "device");
      toast("Bluetooth device connected.", "success"); renderDashboard();
    } catch(e) {
      if (e.name === "NotFoundError") toast("No device was selected.", "error");
      else toast(`Bluetooth connection failed: ${e.message}`, "error");
      $("#bleConnection").textContent = "Disconnected"; $("#bleLog").textContent = e.message;
    }
  }
  function onBleDisconnected() {
    $("#bleConnection").textContent = "Disconnected"; $("#blePill").textContent = "BLE status · Disconnected"; $("#connectBle").classList.remove("hidden"); $("#disconnectBle").classList.add("hidden"); $("#bleBattery").textContent = "Not provided"; $("#bleServices").textContent = "Not discovered"; state.bleServer=null; renderDashboard(); toast("Bluetooth device disconnected.");
  }
  function disconnectBle() { try { if (state.bleDevice?.gatt?.connected) state.bleDevice.gatt.disconnect(); else onBleDisconnected(); } catch(e) { toast(e.message,"error"); } }
  async function registerVolunteer() {
    const user=requireUser(), data={uid:user.uid, displayName:$("#volunteerName").value.trim(), area:$("#volunteerArea").value.trim(), helpType:$("#volunteerType").value, consent:true, status:"pending-review", updatedAt:serverTimestamp()};
    if (!data.displayName || !data.area || !$("#volunteerConsent").checked) throw new Error("Complete all required fields and consent.");
    await db.collection("volunteers").doc(user.uid).set({...data, createdAt:serverTimestamp()}, {merge:true});
    await recordEvent("Volunteer interest registered", "Your volunteer registration is pending review. This does not activate emergency dispatch.", "volunteer");
    toast("Volunteer interest saved. It is pending review.", "success");
  }
  async function loadVolunteerProfile() {
    try { const s=await db.collection("volunteers").doc(requireUser().uid).get(); if(s.exists){const d=s.data();$("#volunteerName").value=d.displayName||"";$("#volunteerArea").value=d.area||"";$("#volunteerType").value=d.helpType||"check-in";$("#volunteerConsent").checked=!!d.consent;} } catch(e) { /* no registration yet or rules deny; surfaced on submit */ }
  }
  async function exportTimeline() {
    const rows = [["Date","Event","Description","Type"]];
    state.timeline.forEach(e => rows.push([toDate(e.createdAt)?.toISOString() || e.clientCreatedAt || "",e.title||"",e.description||"",e.type||""]));
    const csv = rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(",")).join("\r\n");
    const blob=new Blob(["\uFEFF"+csv],{type:"text/csv;charset=utf-8"}), url=URL.createObjectURL(blob), a=document.createElement("a");
    a.href=url;a.download="safety-bubble-timeline.csv";a.click();URL.revokeObjectURL(url);toast("Timeline CSV exported.", "success");
  }
  function showScreen(name) {
    const titles={home:"Good to see you",map:"Safety map",contacts:"Your trusted circle",journey:"Safe journey",timeline:"Activity timeline",device:"Bluetooth device",volunteer:"Community support",settings:"Settings & privacy"};
    if (!titles[name]) return;
    $$(".screen").forEach(el=>el.classList.toggle("active",el.id===`screen-${name}`));
    $$("[data-screen]").forEach(el=>el.classList.toggle("active",el.dataset.screen===name));
    $("#screenTitle").innerHTML=`${escapeHtml(titles[name])}<span class="title-period">.</span>`;
    document.body.classList.remove("menu-open");
    if(name==="map") { if(!state.map) initMap(state.location); setTimeout(()=>state.map?.invalidateSize(),100); }
  }
  function setAuthMode(mode) {
    const signup=mode==="signup"; $$(".auth-tabs .tab").forEach(t=>t.classList.toggle("active",t.dataset.authTab===mode));
    $("#authHeading").textContent=signup?"Create your safety space":"Welcome back";
    $("#authSubheading").textContent=signup?"Start with a secure account.":"Sign in to your safety space.";
    $("#emailAuthSubmit").innerHTML=signup?"Create account <span>→</span>":"Sign in <span>→</span>";
    $("#authPassword").autocomplete=signup?"new-password":"current-password"; $("#emailAuthForm").dataset.mode=mode;
  }
  async function emailAuthSubmit(e) {
    e.preventDefault(); const btn=$("#emailAuthSubmit"); setBusy(btn,true,"Please wait…");
    const email=$("#authEmail").value.trim(), password=$("#authPassword").value, mode=$("#emailAuthForm").dataset.mode || "signin";
    try {
      let credential;
      if(mode==="signup") credential=await auth.createUserWithEmailAndPassword(email,password);
      else credential=await auth.signInWithEmailAndPassword(email,password);
      if(mode==="signup") await credential.user.updateProfile({displayName:email.split("@")[0]});
    } catch(err) { toast(friendlyError(err),"error"); }
    finally { setBusy(btn,false); }
  }
  async function googleSignIn() {
    try { await auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()); }
    catch(e) { if(e.code==="auth/popup-blocked") { try { await auth.signInWithRedirect(new firebase.auth.GoogleAuthProvider()); } catch(er) { toast(friendlyError(er),"error"); } } else toast(friendlyError(e),"error"); }
  }
  async function sendOtp() {
    const number=$("#phoneNumber").value.trim(); if(!/^\+[1-9]\d{7,14}$/.test(number)) { toast("Use international format, e.g. +919876543210.", "error"); return; }
    try {
      if(!state.recaptcha) state.recaptcha=new firebase.auth.RecaptchaVerifier("recaptchaContainer",{size:"normal"});
      await state.recaptcha.render();
      state.phoneConfirmation=await auth.signInWithPhoneNumber(number,state.recaptcha);
      toast("Verification code sent if SMS delivery is available.", "success");
    } catch(e) { toast(friendlyError(e),"error"); try{state.recaptcha?.clear();}catch{} state.recaptcha=null; }
  }
  async function verifyOtp() {
    if(!state.phoneConfirmation) { toast("Request a verification code first.","error"); return; }
    const code=$("#phoneOtp").value.trim(); if(!code) { toast("Enter the verification code.","error"); return; }
    try { await state.phoneConfirmation.confirm(code); state.phoneConfirmation=null; }
    catch(e) { toast(friendlyError(e),"error"); }
  }
  async function submitJourney(e) {
    e.preventDefault();
    const destination=$("#journeyDestination").value.trim(), eta=$("#journeyEta").value, note=$("#journeyNote").value.trim();
    if(!destination || !eta || new Date(eta).getTime() < Date.now()-60000) { toast("Enter a destination and a future arrival time.","error"); return; }
    const ref=db.collection("profiles").doc(requireUser().uid).collection("journeys");
    const batch=db.batch(), existing=await ref.where("status","==","active").get();
    existing.docs.forEach(d=>batch.update(d.ref,{status:"replaced",updatedAt:serverTimestamp()}));
    const doc=ref.doc(); batch.set(doc,{destination,eta:new Date(eta).toISOString(),note,status:"active",createdAt:serverTimestamp(),updatedAt:serverTimestamp()});
    await batch.commit(); state.journey={id:doc.id,destination,eta:new Date(eta).toISOString(),note,status:"active"};
    await recordEvent("Journey planned", `Planned journey to ${destination}.`, "journey");
    renderJourney(); toast("Journey plan saved.", "success"); e.target.reset();
  }
  async function testNotifications() {
    if(!("Notification" in window)) { toast("This browser does not support notifications.","error"); return; }
    const permission=await Notification.requestPermission();
    if(permission==="granted") { new Notification("Safety Bubble",{body:"Notifications are enabled for this browser while it supports them."}); toast("Notification permission granted.","success"); }
    else toast("Notification permission was not granted.","error");
  }
  async function testLocationSetting() {
    try { const pos=await getCurrentPosition();state.location=pos;renderDashboard();initMap(pos);toast(`Location available (about ${Math.round(pos.accuracy)} m accuracy). Not shared.`, "success"); }
    catch(e) { toast(e.message,"error"); }
  }
  function setTheme(theme) { state.theme=theme; document.body.classList.toggle("light",theme==="light"); try{localStorage.setItem("safety-bubble-theme",theme);}catch{} $("#themeToggle").textContent=theme==="light"?"☾":"☼"; }
  function cycleQuote() { state.currentQuote=(state.currentQuote+1)%QUOTES.length;$("#dailyQuote").textContent=QUOTES[state.currentQuote];$("#authQuote").textContent=QUOTES[(state.currentQuote+3)%QUOTES.length]; }
  function setupListeners() {
    $("#emailAuthForm").addEventListener("submit",emailAuthSubmit);
    $$(".auth-tabs .tab").forEach(b=>b.addEventListener("click",()=>setAuthMode(b.dataset.authTab)));
    $("#googleSignIn").addEventListener("click",googleSignIn);
    $("#phoneAuthToggle").addEventListener("click",()=>{$("#phoneAuthForm").classList.toggle("hidden");$("#phoneAuthToggle").textContent=$("#phoneAuthForm").classList.contains("hidden")?"Use phone verification instead":"Hide phone verification";});
    $("#sendOtp").addEventListener("click",sendOtp);$("#verifyOtp").addEventListener("click",verifyOtp);
    $("#signOut").addEventListener("click",()=>auth.signOut());$("#settingsSignOut").addEventListener("click",()=>auth.signOut());
    $$("[data-screen]").forEach(b=>b.addEventListener("click",()=>showScreen(b.dataset.screen)));
    $$("[data-go]").forEach(b=>b.addEventListener("click",()=>showScreen(b.dataset.go)));
    $$("[data-action='add-contact']").forEach(b=>b.addEventListener("click",()=>$("#contactDialog").showModal()));
    $("#mobileMenu").addEventListener("click",()=>document.body.classList.toggle("menu-open"));
    $("#themeToggle").addEventListener("click",()=>setTheme(state.theme==="dark"?"light":"dark"));$("#settingsTheme").addEventListener("click",()=>setTheme(state.theme==="dark"?"light":"dark"));
    $("#nextQuote").addEventListener("click",cycleQuote);
    $("#addContactOpen").addEventListener("click",()=>$("#contactDialog").showModal());
    $$("[data-close-dialog]").forEach(b=>b.addEventListener("click",()=>b.closest("dialog").close()));
    $("#cancelSos").addEventListener("click",()=>$("#sosDialog").close());$("#call112").addEventListener("click",()=>{window.location.href="tel:112";});
    $("#contactForm").addEventListener("submit",async e=>{e.preventDefault();const btn=$("button[type='submit']",e.currentTarget);setBusy(btn,true,"Saving…");try{await addContact({name:$("#contactName").value.trim(),phone:$("#contactPhone").value.trim(),relation:$("#contactRelation").value,email:$("#contactEmail").value.trim()});e.currentTarget.reset();$("#contactDialog").close();}catch(err){toast(friendlyError(err),"error");}finally{setBusy(btn,false);}});
    $("#contactsList").addEventListener("click",e=>{const b=e.target.closest("[data-remove-contact]");if(b)removeContact(b.dataset.removeContact).catch(err=>toast(friendlyError(err),"error"));});
    $("#locateMe").addEventListener("click",locateUser);$("#settingsLocation").addEventListener("click",testLocationSetting);
    $("#findPolice").addEventListener("click",()=>searchNearby("police"));$("#findHospital").addEventListener("click",()=>searchNearby("hospital"));$("#findPharmacy").addEventListener("click",()=>searchNearby("pharmacy"));$("#findSafe").addEventListener("click",()=>searchNearby("safe"));
    $("#sosButton").addEventListener("click",activateSOS);$("#journeyForm").addEventListener("submit",submitJourney);
    $("#connectBle").addEventListener("click",connectBle);$("#disconnectBle").addEventListener("click",disconnectBle);
    $("#volunteerForm").addEventListener("submit",async e=>{e.preventDefault();const btn=$("button[type='submit']",e.currentTarget);setBusy(btn,true,"Saving…");try{await registerVolunteer();}catch(err){toast(friendlyError(err),"error");}finally{setBusy(btn,false);}});
    $("#exportTimeline").addEventListener("click",exportTimeline);$("#enableNotifications").addEventListener("click",testNotifications);
    $$("[data-check]").forEach(input=>input.addEventListener("change",()=>{const count=$$("[data-check]:checked").length;$("#checkProgress").textContent=`${count}/3`;try{localStorage.setItem("safety-bubble-checklist",JSON.stringify($$("[data-check]").filter(x=>x.checked).map(x=>x.dataset.check)));}catch{}}));
  }
  function initFirebase() {
    if(!window.SAFETY_BUBBLE_FIREBASE_CONFIG || !window.SAFETY_BUBBLE_FIREBASE_CONFIG.apiKey) throw new Error("Firebase config is missing. Check firebase-config.js.");
    if(!firebase.apps.length) firebase.initializeApp(window.SAFETY_BUBBLE_FIREBASE_CONFIG);
    auth=firebase.auth();db=firebase.firestore();
    try { if(firebase.analytics && location.protocol!=="file:") analytics=firebase.analytics(); } catch(e) { console.info("Analytics unavailable in this browser.",e.message); }
    auth.getRedirectResult().catch(e=>toast(friendlyError(e),"error"));
    auth.onAuthStateChanged(user=>{state.user=user;if(user)showApp(user);else showAuth();});
  }
  function init() {
    setupListeners();
    try { const saved=localStorage.getItem("safety-bubble-theme");setTheme(saved==="light"?"light":"dark"); const checklist=JSON.parse(localStorage.getItem("safety-bubble-checklist")||"[]");$$("[data-check]").forEach(i=>i.checked=checklist.includes(i.dataset.check));$("#checkProgress").textContent=`${$$("[data-check]:checked").length}/3`; } catch {}
    $("#dailyQuote").textContent=QUOTES[0];$("#authQuote").textContent=QUOTES[3];setAuthMode("signin");
    try { initFirebase(); } catch(e) { showAuth(); toast(e.message,"error"); console.error(e); }
    if("serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register("./service-worker.js").catch(e=>console.warn("PWA service worker unavailable:",e));
  }
  document.addEventListener("DOMContentLoaded",init);
})();
