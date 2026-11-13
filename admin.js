"use strict";

const get = id => document.getElementById(id);
const client = window.supabase?.createClient(
  "https://oydhphpbcsiedfkkwujq.supabase.co",
  "sb_publishable_HjB_yE3s66LO8FsS4n2iGw_Jh73wk-m"
);
const bucket = client?.storage.from("pacific-hearts-profile-photos");
const dialog = get("member-dialog");
const pageSize = 25;
const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const labels = {
  active: "Active", suspended: "Suspended", banned: "Banned",
  owner: "Owner", moderator: "Moderator",
  suspend: "Suspend", ban: "Ban permanently", restore: "Restore",
  open: "Open", reviewing: "Reviewing", resolved: "Resolved", dismissed: "Dismissed",
  message_report: "Message report", member_report: "Member report", photo_report: "Photo report",
  harassment: "Harassment", spam_or_scam: "Spam or scam",
  inappropriate_content: "Inappropriate content", other: "Other"
};
let accessRequest = 0;
let memberRequest = 0;
let caseRequest = 0;
let detailRequest = 0;
let staffRole;
let adminUser;
let currentTab = "members";
let memberCursor;
let caseCursor;
let memberFilters = { search_term: "", status_filter: "all" };
let caseFilter = "all";
let detailTarget;

function node(tag, value, className) {
  const element = document.createElement(tag);
  if (value !== undefined) element.textContent = value;
  if (className) element.className = className;
  return element;
}

function button(text, onClick, className) {
  const element = node("button", text, className);
  element.type = "button";
  element.addEventListener("click", onClick);
  return element;
}

function labeled(text, control) {
  const label = node("label", text);
  label.append(control);
  return label;
}

function status(id, message, isError = false) {
  const element = get(id);
  element.textContent = message;
  element.classList.toggle("error", isError);
}

function displayDate(value) {
  return value ? date.format(new Date(value)) : "—";
}

async function rpc(name, args) {
  const { data, error } = await client.rpc(name, args);
  if (error) throw error;
  return data;
}

function handleError(id, error, fallback) {
  if (error.code === "42501") {
    void refresh();
    return;
  }
  const actionable = ["22023", "40001", "P0002"].includes(error.code);
  status(id, actionable ? error.message : fallback, true);
}

function clearPrivateContent() {
  ++memberRequest;
  ++caseRequest;
  ++detailRequest;
  staffRole = null;
  adminUser = null;
  get("dashboard").hidden = true;
  get("member-list").replaceChildren();
  get("case-list").replaceChildren();
  get("member-detail").replaceChildren();
  if (dialog.open) dialog.close();
  detailTarget = null;
}

async function refresh() {
  const request = ++accessRequest;
  clearPrivateContent();
  get("sign-in").hidden = true;
  get("refresh").disabled = true;
  status("access-status", "Checking access…");
  try {
    if (!client) throw new Error("Supabase did not load");
    const { data, error } = await client.auth.getUser();
    if (request !== accessRequest) return;
    if (error?.name === "AuthSessionMissingError" || (!error && !data?.user)) {
      status("access-status", "Sign in with an administrator account.");
      get("sign-in").hidden = false;
      return;
    }
    if (error) throw error;
    const dashboard = await rpc("ph_admin_dashboard");
    if (request !== accessRequest) return;
    staffRole = dashboard.staff_role;
    adminUser = data.user.id;
    if (!["owner", "moderator"].includes(staffRole)) {
      status("access-status", "Member management is awaiting its Supabase update.");
      return;
    }
    for (const key of ["profiles", "messages", "open_cases"]) get(key).textContent = dashboard[key];
    get("dashboard").hidden = false;
    status("access-status", "Signed in as " + labels[staffRole].toLowerCase() + ".");
    void (currentTab === "members" ? loadMembers() : loadCases());
  } catch (error) {
    if (request !== accessRequest) return;
    const forbidden = error.code === "42501";
    status("access-status", forbidden ? "This account does not have administrator access." : "Could not verify access. Try refreshing.", true);
  } finally {
    if (request === accessRequest) get("refresh").disabled = false;
  }
}

function openTab(tab) {
  if (tab === currentTab) return;
  currentTab = tab;
  for (const name of ["members", "reports"]) {
    get(name + "-tab").setAttribute("aria-pressed", String(name === tab));
    get(name + "-panel").hidden = name !== tab;
  }
  void (tab === "members" ? loadMembers() : loadCases());
}

function memberRow(member) {
  const item = node("li");
  const info = node("div");
  const name = member.display_name || member.email || member.id;
  info.append(node("strong", name));
  if (member.display_name && member.email) info.append(node("p", member.email, "muted"));
  const place = [member.city, member.country].filter(Boolean).join(", ");
  if (place) info.append(node("p", place, "muted"));
  info.append(node("span", labels[member.status], "badge " + member.status));
  const view = button("View member", () => openMember(member.id), "secondary");
  view.setAttribute("aria-label", "View member " + name);
  item.append(info, view);
  return item;
}

async function loadMembers(append = false) {
  if (!staffRole) return;
  const request = ++memberRequest;
  const list = get("member-list");
  const more = get("more-members");
  if (!append) {
    memberCursor = null;
    list.replaceChildren();
  }
  more.disabled = true;
  more.hidden = !append;
  status("member-status", "Loading members…");
  try {
    const rows = await rpc("ph_admin_members", {
      ...memberFilters, before_joined: memberCursor?.joined_cursor ?? null, before_id: memberCursor?.id ?? null
    });
    if (request !== memberRequest) return;
    const page = rows.slice(0, pageSize);
    list.append(...page.map(memberRow));
    memberCursor = page.at(-1);
    more.hidden = rows.length <= pageSize;
    status("member-status", list.children.length ? list.children.length + " members shown." : "No members match this search.");
  } catch (error) {
    if (request === memberRequest) handleError("member-status", error, "Could not load members. Try again.");
  } finally {
    if (request === memberRequest) more.disabled = false;
  }
}

function detailField(list, title, value) {
  const field = node("div");
  field.append(node("dt", title), node("dd", value ?? "—"));
  list.append(field);
}

function renderMember(member) {
  const panel = get("member-detail");
  const profile = member.profile;
  get("detail-title").textContent = profile?.display_name || member.email || "Member details";
  const fields = node("dl", undefined, "detail-grid");
  detailField(fields, "Email", member.email);
  detailField(fields, "Member ID", member.id);
  detailField(fields, "Registered", displayDate(member.joined_at));
  detailField(fields, "Email confirmed", member.email_confirmed_at ? displayDate(member.email_confirmed_at) : "Pending");
  detailField(fields, "Account status", labels[member.status]);
  if (member.status === "suspended") detailField(fields, "Suspended until", displayDate(member.restricted_until));
  if (member.staff_role) detailField(fields, "Staff role", labels[member.staff_role]);
  panel.append(fields, node("h3", "Profile"));
  if (profile) {
    const profileFields = node("dl", undefined, "detail-grid");
    detailField(profileFields, "Age", profile.age);
    detailField(profileFields, "Location", [profile.city, profile.country].filter(Boolean).join(", ") || "—");
    detailField(profileFields, "Children", profile.has_children == null ? "—" : profile.has_children ? "Yes" : "No");
    detailField(profileFields, "Relationship goal", profile.relationship_goal);
    panel.append(profileFields);
    if (profile.about_me) panel.append(node("p", profile.about_me, "profile-bio"));
  } else {
    panel.append(node("p", "This member has not created a profile."));
  }
  panel.append(node("h3", "Photos"));
  const gallery = node("div", undefined, "gallery");
  panel.append(gallery);
  if (!member.photos.length) gallery.append(node("p", "No profile photos."));
  if (staffRole === "owner" && !member.staff_role) panel.append(decisionForm(member));
  if (member.history.length) {
    const history = node("ul");
    for (const item of member.history) {
      history.append(node("li", displayDate(item.created_at) + " · " + labels[item.after_state.status] + " · " + item.reason));
    }
    panel.append(node("h3", "Account decisions"), history);
  }
  return gallery;
}

async function openMember(id, success = "") {
  if (!staffRole) return;
  const request = ++detailRequest;
  detailTarget = id;
  get("detail-title").textContent = "Member details";
  get("member-detail").replaceChildren();
  status("detail-status", "Loading member…");
  if (!dialog.open) dialog.showModal();
  try {
    const member = await rpc("ph_admin_member", { target: id });
    if (request !== detailRequest) return;
    const gallery = renderMember(member);
    status("detail-status", success);
    if (!member.photos.length) return;
    const { data, error } = await bucket.createSignedUrls(member.photos.map(photo => photo.path), 120);
    if (request !== detailRequest) return;
    if (error) {
      gallery.append(node("p", "Profile photos could not load."));
      return;
    }
    const urls = new Map(data?.map(item => [item.path, item.signedUrl]));
    for (const photo of member.photos) {
      const figure = node("figure");
      const caption = photo.is_preferred ? "Primary photo" : "Photo " + photo.slot;
      const url = urls.get(photo.path);
      if (url) {
        const image = node("img");
        image.alt = caption;
        image.referrerPolicy = "no-referrer";
        image.addEventListener("error", () => image.replaceWith(node("p", "Photo could not load.")), { once: true });
        image.src = url;
        figure.append(image);
      } else {
        figure.append(node("p", "Photo could not load."));
      }
      figure.append(node("figcaption", caption));
      gallery.append(figure);
    }
  } catch (error) {
    if (request === detailRequest) handleError("detail-status", error, "Could not load this member. Try again.");
  }
}

function decisionForm(member) {
  const form = node("form", undefined, "decision-form");
  const choice = node("select");
  const options = member.status === "banned" ? ["restore"] :
    member.status === "suspended" ? ["suspend", "ban", "restore"] : ["suspend", "ban"];
  for (const option of ["", ...options]) {
    const item = node("option", labels[option] || "Select an action");
    item.value = option;
    choice.append(item);
  }
  choice.required = true;
  const days = node("input");
  days.type = "number";
  days.min = "1";
  days.max = "365";
  days.value = "7";
  days.inputMode = "numeric";
  const dayLabel = labeled("Suspension length in days", days);
  dayLabel.hidden = true;
  days.disabled = true;
  const reason = node("textarea");
  reason.required = true;
  reason.maxLength = 2000;
  const save = node("button", "Apply account decision", "danger");
  save.type = "submit";
  save.disabled = true;
  choice.addEventListener("change", () => {
    days.disabled = dayLabel.hidden = choice.value !== "suspend";
    save.disabled = !choice.value;
  });
  form.append(node("h3", "Change account status"), labeled("Action", choice), dayLabel, labeled("Reason", reason), save);
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const reasonText = reason.value.trim();
    if (!reasonText) {
      status("detail-status", "Enter a reason before applying the decision.", true);
      reason.focus();
      return;
    }
    const action = choice.value;
    const duration = action === "suspend" ? " for " + days.value + " days" : "";
    const name = member.profile?.display_name || member.email || member.id;
    if (!window.confirm(labels[action] + " " + name + duration + "?")) return;
    const request = detailRequest;
    save.disabled = choice.disabled = days.disabled = reason.disabled = true;
    try {
      await rpc("ph_admin_change_member", {
        target: member.id, action_name: action, days: action === "suspend" ? Number(days.value) : null,
        decision_reason: reasonText, expected_version: member.version
      });
      if (staffRole && currentTab === "members") void loadMembers();
      if (request === detailRequest && detailTarget === member.id) await openMember(member.id, "Account decision recorded.");
    } catch (error) {
      if (request === detailRequest) handleError("detail-status", error, "Could not save the account decision. Try again.");
    } finally {
      save.disabled = choice.disabled = reason.disabled = false;
      days.disabled = dayLabel.hidden;
    }
  });
  return form;
}

function reportCard(report) {
  const article = node("article", undefined, "case");
  article.append(
    node("h3", (labels[report.source] || report.source) + " #" + report.id),
    node("p", (labels[report.reason] || report.reason) + " · " + displayDate(report.created_at)),
    node("p", "Reported by " + (report.reporter_name || report.reporter_id || "Unknown member"), "muted")
  );
  if (report.subject_id) {
    article.append(button("View reported member", () => openMember(report.subject_id), "secondary"));
    if (report.subject_name) article.append(node("p", report.subject_name));
  }
  if (report.reported_message) article.append(node("blockquote", report.reported_message));
  if (report.handled_at) article.append(node("p", "Last decision " + displayDate(report.handled_at), "muted"));
  const form = node("form");
  const choice = node("select");
  for (const value of ["open", "reviewing", "resolved", "dismissed"]) {
    const item = node("option", labels[value]);
    item.value = value;
    item.selected = report.status === value;
    choice.append(item);
  }
  const notes = node("textarea");
  notes.maxLength = 2000;
  notes.value = report.notes || "";
  const save = node("button", "Save decision");
  save.type = "submit";
  const feedback = node("p");
  feedback.setAttribute("role", "status");
  form.append(labeled("Decision", choice), labeled("Private notes", notes), save, feedback);
  article.append(form);
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const nextStatus = choice.value;
    const reason = notes.value.trim();
    if (["resolved", "dismissed"].includes(nextStatus) && !reason) {
      feedback.textContent = "Add notes explaining this decision.";
      notes.focus();
      return;
    }
    save.disabled = choice.disabled = notes.disabled = true;
    try {
      await rpc("ph_admin_record_decision", {
        case_key: report.id, new_status: nextStatus, review_notes: reason, expected_review: report.handled_at
      });
      if (staffRole && currentTab === "reports") {
        await loadCases(false, "Report #" + report.id + " decision recorded.");
        void refreshCounts();
      }
    } catch (error) {
      if (error.code === "42501") void refresh();
      else feedback.textContent = error.code === "40001" ? error.message : "Could not save this decision. Try again.";
    } finally {
      save.disabled = choice.disabled = notes.disabled = false;
    }
  });
  return article;
}

async function refreshCounts() {
  const request = accessRequest;
  try {
    const dashboard = await rpc("ph_admin_dashboard");
    if (request === accessRequest) get("open_cases").textContent = dashboard.open_cases;
  } catch (error) {
    if (request === accessRequest && error.code === "42501") void refresh();
  }
}

async function loadCases(append = false, success = "") {
  if (!staffRole) return;
  const request = ++caseRequest;
  const list = get("case-list");
  const more = get("more-cases");
  if (!append) {
    caseCursor = null;
    list.replaceChildren();
  }
  more.disabled = true;
  more.hidden = !append;
  status("case-status", "Loading reports…");
  try {
    const rows = await rpc("ph_admin_cases", { status_filter: caseFilter, before_id: caseCursor });
    if (request !== caseRequest) return;
    const page = rows.slice(0, pageSize);
    list.append(...page.map(reportCard));
    caseCursor = page.at(-1)?.id ?? null;
    more.hidden = rows.length <= pageSize;
    const message = list.children.length ? list.children.length + " reports shown." : "No reports match this filter.";
    status("case-status", [success, message].filter(Boolean).join(" "));
  } catch (error) {
    if (request === caseRequest) handleError("case-status", error, "Could not load reports. Try again.");
  } finally {
    if (request === caseRequest) more.disabled = false;
  }
}

get("refresh").addEventListener("click", refresh);
get("members-tab").addEventListener("click", () => openTab("members"));
get("reports-tab").addEventListener("click", () => openTab("reports"));
get("member-search").addEventListener("submit", event => {
  event.preventDefault();
  memberFilters = { search_term: get("search-term").value.trim(), status_filter: get("member-filter").value };
  void loadMembers();
});
get("case-filter").addEventListener("change", event => {
  caseFilter = event.target.value;
  void loadCases();
});
get("more-members").addEventListener("click", () => loadMembers(true));
get("more-cases").addEventListener("click", () => loadCases(true));
dialog.addEventListener("close", () => {
  if (dialog.open) return;
  ++detailRequest;
  detailTarget = null;
  get("member-detail").replaceChildren();
});
client?.auth.onAuthStateChange((event, session) => {
  if (event === "SIGNED_OUT" || (adminUser && session?.user.id !== adminUser)) {
    ++accessRequest;
    clearPrivateContent();
    setTimeout(refresh, 0);
  }
});
void refresh();
