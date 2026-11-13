"use strict";

const get = id => document.getElementById(id);
const connection = get("connection-status");
const action = get("action-status");
const historyPanel = get("history");
const messageList = get("message-list");
const reportDialog = get("report-dialog");
const requestedPeer = new URLSearchParams(location.search).get("member");
const uuidPattern = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const pageSize = 30;
let client;
let member;
let peer;
let channel;
let poll;
let stopped = false;
let initialized = false;
let refreshPending = false;
let refreshing = false;
let realtime = false;
let threadId;
let oldestId;
let newestId;
let readThrough = 0;
let markingRead = false;
let blockedByMe = false;
let blockPending = false;
let blockRevision = 0;
let sending = false;
let draftRequest;
let reportTarget;
let inboxRows = [];
let moreInbox = false;

function showStatus(element, message, error = false) {
  element.textContent = message;
  element.classList.toggle("error", error);
}

function errorText(error, fallback) {
  switch (error?.message) {
    case "PH_ACCOUNT_RESTRICTED": return "This session cannot access Pacific Hearts.";
    case "PH_PROFILE_REQUIRED": return "Save your member profile before using messages.";
    case "PH_MESSAGING_UNAVAILABLE": return "Messaging with this member is unavailable.";
    case "PH_INVALID_MESSAGE": return "Enter a message of 1 to 2,000 characters.";
    case "PH_SEND_LIMIT": return "You’ve reached a sending limit. Try again later.";
    case "PH_REPORT_LIMIT": return "You’ve reached the reporting limit. Try again later.";
    default: return fallback;
  }
}

async function result(request) {
  const { data, error } = await request;
  if (error) throw error;
  return data;
}

function threadLink(id) {
  return "messages.html?" + new URLSearchParams({ member: id });
}

function renderInbox() {
  const items = inboxRows.map(row => {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.className = "conversation";
    link.href = threadLink(row.peer_id);
    const name = document.createElement("strong");
    name.textContent = row.display_name || "Member";
    link.append(name);
    if (Number(row.unread_count) > 0) {
      const unread = document.createElement("span");
      unread.className = "unread";
      unread.textContent = row.unread_count + " unread";
      link.append(unread);
    }
    const preview = document.createElement("span");
    preview.className = "preview";
    preview.textContent = row.latest_body;
    link.append(preview);
    item.append(link);
    return item;
  });
  if (!items.length) {
    const item = document.createElement("li");
    item.textContent = "No conversations yet. Open a member profile to send a message.";
    items.push(item);
  }
  get("conversations").replaceChildren(...items);
  get("more-conversations").hidden = !moreInbox;
}

async function refreshInbox(older = false) {
  const cutoff = older ? inboxRows.at(-1)?.latest_id : null;
  const data = await result(client.rpc("ph_inbox", { before_message: cutoff }));
  if (stopped) return;
  const page = data.slice(0, pageSize);
  if (older) {
    const existing = new Set(inboxRows.map(row => row.peer_id));
    inboxRows.push(...page.filter(row => !existing.has(row.peer_id)));
    moreInbox = data.length > pageSize;
  } else {
    const previousRows = inboxRows;
    const seen = new Set(page.map(row => row.peer_id));
    const previousTail = previousRows.at(-1)?.latest_id;
    const tail = page.at(-1)?.latest_id;
    const retained = data.length > pageSize && previousRows.length > pageSize
      ? previousRows.filter(row => !seen.has(row.peer_id) && row.latest_id < tail)
      : [];
    inboxRows = [...page, ...retained];
    moreInbox = data.length > pageSize && (!retained.length || moreInbox || previousTail !== inboxRows.at(-1)?.latest_id);
  }
  renderInbox();
}

function timeLabel(value) {
  const time = document.createElement("time");
  time.dateTime = value;
  time.textContent = dateFormat.format(new Date(value));
  return time;
}

function renderMessage(row) {
  const incoming = row.sender_id !== member;
  const item = document.createElement("li");
  if (!incoming) item.className = "outgoing";
  const body = document.createElement("p");
  body.className = "bubble";
  body.textContent = row.body;
  const meta = document.createElement("div");
  meta.className = "message-meta";
  const sender = document.createElement("span");
  sender.textContent = incoming ? get("thread-name").textContent : "You";
  meta.append(sender, timeLabel(row.created_at));
  if (incoming) {
    const report = document.createElement("button");
    report.type = "button";
    report.className = "report";
    report.textContent = "Report";
    report.setAttribute("aria-label", "Report message sent " + dateFormat.format(new Date(row.created_at)));
    report.onclick = () => {
      reportTarget = row.id;
      get("report-form").reset();
      showStatus(get("report-status"), "");
      reportDialog.showModal();
    };
    meta.append(report);
  }
  item.append(body, meta);
  return item;
}

function isAtBottom() {
  return historyPanel.scrollHeight - historyPanel.scrollTop - historyPanel.clientHeight < 36;
}

async function markRead() {
  if (stopped || document.hidden || !newestId || newestId <= readThrough || markingRead || !isAtBottom()) return;
  const through = newestId;
  markingRead = true;
  try {
    await result(client.rpc("ph_mark_messages_read", { thread_id: threadId, message_id: through }));
    readThrough = through;
  } catch {
    return;
  } finally {
    markingRead = false;
  }
  if (newestId > through) void markRead();
}

function threadQuery() {
  return client.from("ph_messages").select("id,sender_id,body,created_at").eq("conversation_id", threadId);
}

async function loadOlderMessages() {
  const button = get("older");
  if (!oldestId || button.disabled) return;
  button.disabled = true;
  try {
    const rows = await result(threadQuery().lt("id", oldestId).order("id", { ascending: false }).limit(pageSize + 1));
    if (stopped) return;
    const firstExisting = messageList.firstElementChild;
    const priorTop = firstExisting.getBoundingClientRect().top;
    const page = rows.slice(0, pageSize);
    messageList.prepend(...page.reverse().map(renderMessage));
    oldestId = page[0]?.id ?? oldestId;
    button.hidden = rows.length <= pageSize;
    historyPanel.scrollTop += firstExisting.getBoundingClientRect().top - priorTop;
    showStatus(action, "");
  } catch {
    if (!stopped) showStatus(action, "Older messages could not load. Try again.", true);
  } finally {
    button.disabled = false;
  }
}

function updateComposer() {
  get("block").textContent = blockedByMe ? "Unblock member" : "Block member";
  get("block").disabled = blockPending || sending;
  get("composer").hidden = blockedByMe;
  get("message-text").readOnly = sending;
  get("send").disabled = sending || blockPending;
}

async function refreshThread() {
  if (!blockPending) {
    const revision = blockRevision;
    const block = await result(client.from("ph_message_blocks").select("blocked_id").eq("blocked_id", peer).maybeSingle());
    if (stopped) return;
    if (revision === blockRevision && !blockPending) {
      blockedByMe = !!block;
      updateComposer();
    }
  }
  if (!threadId) {
    const [member_a, member_b] = [member, peer].sort();
    const row = await result(client.from("ph_conversations").select("id").eq("member_a", member_a).eq("member_b", member_b).maybeSingle());
    if (stopped) return;
    threadId = row?.id;
  }
  if (!threadId) {
    get("empty-thread").hidden = false;
    return;
  }
  if (!newestId) {
    const rows = await result(threadQuery().order("id", { ascending: false }).limit(pageSize + 1));
    if (stopped) return;
    const page = rows.slice(0, pageSize).reverse();
    messageList.append(...page.map(renderMessage));
    oldestId = page[0]?.id;
    newestId = page.at(-1)?.id;
    get("older").hidden = rows.length <= pageSize;
    historyPanel.scrollTop = historyPanel.scrollHeight;
  } else {
    const rows = await result(threadQuery().gt("id", newestId).order("id").limit(100));
    if (stopped) return;
    const stickToBottom = isAtBottom();
    messageList.append(...rows.map(renderMessage));
    newestId = rows.at(-1)?.id ?? newestId;
    if (stickToBottom) historyPanel.scrollTop = historyPanel.scrollHeight;
    if (rows.length === 100) refreshPending = true;
  }
  get("empty-thread").hidden = !!newestId;
  void markRead();
}

async function refresh() {
  if (stopped || !initialized || document.hidden) return;
  refreshPending = true;
  if (refreshing) return;
  refreshing = true;
  try {
    const allowed = await result(client.rpc("ph_member_access_allowed"));
    if (stopped) return;
    if (!allowed) {
      stop("This session cannot access Pacific Hearts. Sign in again if your account has been restored.", true);
      return;
    }
    while (refreshPending && !stopped && !document.hidden) {
      refreshPending = false;
      if (peer) await refreshThread();
      else await refreshInbox();
      if (!stopped) showStatus(connection, realtime ? "" : "Checking for messages periodically…");
    }
  } catch {
    if (!stopped) showStatus(connection, "Messages could not refresh. We’ll try again shortly.", true);
  } finally {
    refreshing = false;
  }
}

function stop(message, offerSignIn = false) {
  stopped = true;
  clearInterval(poll);
  if (channel) void client.removeChannel(channel);
  reportDialog.close();
  get("thread").hidden = true;
  get("inbox").hidden = true;
  messageList.replaceChildren();
  get("conversations").replaceChildren();
  get("message-text").value = "";
  get("thread-name").textContent = "";
  inboxRows = [];
  draftRequest = null;
  showStatus(action, "");
  showStatus(connection, message);
  get("sign-in").hidden = !offerSignIn;
}

async function start() {
  if (!window.supabase) {
    stop("Messaging could not load. Reload the page to try again.");
    return;
  }
  client = window.supabase.createClient(
    "https://oydhphpbcsiedfkkwujq.supabase.co",
    "sb_publishable_HjB_yE3s66LO8FsS4n2iGw_Jh73wk-m"
  );
  client.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_OUT" || (member && session?.user.id && session.user.id !== member)) {
      setTimeout(() => stop("Your sign-in changed. Reload Messages to continue.", true), 0);
    }
  });
  let user;
  try {
    user = (await result(client.auth.getUser())).user;
  } catch (error) {
    if (error?.name === "AuthSessionMissingError" || error?.status === 401) {
      stop("Sign in to read and send messages.", true);
    } else {
      stop("Your sign-in could not be checked. Reload the page to try again.");
    }
    return;
  }
  if (stopped) return;
  if (!user || user.is_anonymous) {
    stop("Sign in to read and send messages.", true);
    return;
  }
  member = user.id;
  if (requestedPeer !== null) {
    get("back-to-inbox").hidden = false;
    if (!uuidPattern.test(requestedPeer) || requestedPeer.toLowerCase() === member) {
      stop("This member is unavailable.");
      return;
    }
    peer = requestedPeer.toLowerCase();
  }
  try {
    const allowed = await result(client.rpc("ph_member_access_allowed"));
    if (stopped) return;
    if (!allowed) {
      stop("This session cannot access Pacific Hearts. Sign in again if your account has been restored.", true);
      return;
    }
    const ids = peer ? [member, peer] : [member];
    const profiles = await result(client.from("profiles").select("id,display_name").in("id", ids).gte("age", 18));
    if (stopped) return;
    if (!profiles.some(profile => profile.id === member)) {
      stop("Save your member profile before using messages.");
      return;
    }
    const other = profiles.find(profile => profile.id === peer);
    if (peer && !other) {
      stop("This member is unavailable.");
      return;
    }
    if (peer) get("thread-name").textContent = other.display_name || "Member";
    get(peer ? "thread" : "inbox").hidden = false;
    initialized = true;
    showStatus(connection, "Loading messages…");
    channel = client.channel("pacific-hearts-messages:" + member, { config: { private: true } });
    channel.on("broadcast", { event: "refresh" }, refresh);
    channel.subscribe(state => {
      realtime = state === "SUBSCRIBED";
      void refresh();
    });
    poll = setInterval(refresh, 15000);
    void refresh();
  } catch {
    stop("Messages could not load. Reload the page to try again.");
  }
}

get("more-conversations").onclick = async () => {
  if (refreshing || stopped) return;
  refreshing = true;
  const button = get("more-conversations");
  button.disabled = true;
  try {
    await refreshInbox(true);
    if (!stopped) showStatus(action, "");
  } catch {
    if (!stopped) showStatus(action, "Older conversations could not load. Try again.", true);
  } finally {
    button.disabled = false;
    refreshing = false;
    if (refreshPending) void refresh();
  }
};
get("older").onclick = loadOlderMessages;
historyPanel.addEventListener("scroll", markRead, { passive: true });
document.addEventListener("visibilitychange", refresh);
window.addEventListener("online", refresh);
window.addEventListener("focus", refresh);
window.addEventListener("pageshow", event => {
  if (event.persisted) location.reload();
});

get("composer").onsubmit = async event => {
  event.preventDefault();
  if (stopped || sending || blockPending || blockedByMe) return;
  const input = get("message-text");
  const body = input.value.trim();
  if (!body) {
    showStatus(action, "Write a message first.", true);
    return;
  }
  if (draftRequest?.body !== body) draftRequest = { body, key: crypto.randomUUID() };
  sending = true;
  updateComposer();
  showStatus(action, "Sending…");
  try {
    await result(client.rpc("ph_send_message", { peer, message_body: body, request_key: draftRequest.key }));
    if (stopped) return;
    draftRequest = null;
    input.value = "";
    historyPanel.scrollTop = historyPanel.scrollHeight;
    showStatus(action, "Message sent.");
    void refresh();
  } catch (error) {
    if (!stopped) showStatus(action, errorText(error, "Delivery could not be confirmed. Try sending again."), true);
  } finally {
    sending = false;
    if (!stopped) updateComposer();
  }
};

get("block").onclick = async () => {
  if (stopped || blockPending || sending) return;
  const blocked = !blockedByMe;
  if (blocked && !confirm("Block this member? Neither of you will be able to send new messages to the other. You can still view and report past messages.")) return;
  blockPending = true;
  ++blockRevision;
  updateComposer();
  try {
    await result(client.rpc("ph_set_message_block", { peer, blocked }));
    if (stopped) return;
    blockedByMe = blocked;
    showStatus(action, blocked ? "Member blocked." : "Member unblocked.");
  } catch (error) {
    if (!stopped) showStatus(action, errorText(error, "The block setting could not be saved. Try again."), true);
  } finally {
    blockPending = false;
    if (!stopped) updateComposer();
  }
};

get("cancel-report").onclick = () => reportDialog.close();
reportDialog.addEventListener("cancel", event => {
  if (get("submit-report").disabled) event.preventDefault();
});
get("report-form").onsubmit = async event => {
  event.preventDefault();
  const submit = get("submit-report");
  const cancel = get("cancel-report");
  if (stopped || submit.disabled || !reportTarget) return;
  submit.disabled = cancel.disabled = true;
  try {
    await result(client.rpc("ph_report_message", { target_message: reportTarget, report_reason: get("report-reason").value }));
    if (stopped) return;
    reportDialog.close();
    showStatus(action, "Report submitted.");
  } catch (error) {
    if (!stopped) showStatus(get("report-status"), errorText(error, "The report could not be submitted. Try again."), true);
  } finally {
    submit.disabled = cancel.disabled = false;
  }
};

void start();
