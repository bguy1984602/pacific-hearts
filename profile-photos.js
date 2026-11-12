function setupProfilePhotos(client) {
  const bucket = client.storage.from("pacific-hearts-profile-photos");
  const panel = document.getElementById("photoPanel");
  const picker = document.getElementById("photoFile");
  const add = document.getElementById("addPhoto");
  const gallery = document.getElementById("ownPhotos");
  const message = document.getElementById("photoStatus");
  const profileDialog = document.getElementById("memberProfile");
  const dialogTitle = document.getElementById("memberName");
  const dialogBody = document.getElementById("memberDetails");
  const fileTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/avif", "image/heic", "image/heif"]);
  let memberId = null;
  let saved = false;
  let photos = [];
  let replacement = null;
  let ready = false;
  let pending = false;
  let editorRequest = 0;
  let profileRequest = 0;

  function say(text, error = false) {
    message.textContent = text;
    message.className = error ? "error" : "";
  }

  async function list(ids) {
    if (!ids.length) return [];
    const { data, error } = await client.rpc("list_profile_photos", { member_ids: ids });
    if (error) throw error;
    return data;
  }

  async function sign(rows) {
    if (!rows.length) return new Map();
    const { data, error } = await bucket.createSignedUrls(rows.map(photo => photo.path), 600);
    if (error) throw error;
    return new Map(data.filter(photo => photo.signedUrl).map(photo => [photo.path, photo.signedUrl]));
  }

  function photoImage(url, alt) {
    const image = document.createElement("img");
    image.alt = alt;
    image.decoding = "async";
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";
    if (url) image.src = url;
    return image;
  }

  function showThumbnail(container, url, alt) {
    if (!url) return;
    const image = photoImage(url, alt);
    // Keep the placeholder until the image loads.
    image.classList.add("thumbnail-loading");
    image.addEventListener("load", () => {
      image.classList.remove("thumbnail-loading");
      container.replaceChildren(image);
    }, { once: true });
    image.addEventListener("error", () => image.remove(), { once: true });
    container.append(image);
  }

  function button(label, action) {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = label;
    element.onclick = action;
    return element;
  }

  function updateControls() {
    add.disabled = pending || !ready || photos.length >= 5;
    picker.disabled = pending || !ready;
    gallery.querySelectorAll("button").forEach(control => { control.disabled = pending; });
    panel.setAttribute("aria-busy", String(pending));
  }

  function openPicker(photo) {
    replacement = photo;
    picker.value = "";
    picker.click();
  }

  function renderEditor(rows, urls) {
    gallery.replaceChildren();
    rows.forEach((photo, index) => {
      const card = document.createElement("article");
      const title = document.createElement("h4");
      title.textContent = index === 0 ? "Primary photo" : "Photo " + (index + 1);
      card.className = "photo-card";
      card.append(title);
      if (urls.has(photo.path)) {
        card.append(photoImage(urls.get(photo.path), title.textContent));
      } else {
        const unavailable = document.createElement("p");
        unavailable.textContent = "Preview unavailable.";
        card.append(unavailable);
      }
      const controls = document.createElement("div");
      controls.className = "photo-controls";
      if (index > 0) {
        controls.append(button("Make primary", () => perform(async () => {
          await setPrimary(photo);
          return "Primary photo updated.";
        })));
      }
      controls.append(
        button("Replace", () => openPicker(photo)),
        button("Delete", () => {
          if (!window.confirm("Delete this profile photo?")) return;
          perform(async () => {
            const { error } = await bucket.remove([photo.path]);
            if (error) throw error;
            return "Photo deleted.";
          });
        })
      );
      card.append(controls);
      gallery.append(card);
    });
    document.getElementById("photoCount").textContent = rows.length + " of 5 photos";
  }

  async function loadEditor() {
    const request = ++editorRequest;
    if (!memberId || !saved) return;
    const rows = await list([memberId]);
    let urls;
    try {
      urls = await sign(rows);
    } catch {
      urls = new Map();
    }
    if (request !== editorRequest) return;
    photos = rows;
    ready = true;
    renderEditor(rows, urls);
    updateControls();
  }

  function setMember(id, hasProfile) {
    if (id === memberId && hasProfile === saved) return;
    ++editorRequest;
    ++profileRequest;
    profileDialog.close();
    dialogBody.replaceChildren();
    memberId = id;
    saved = hasProfile;
    pending = false;
    ready = false;
    photos = [];
    replacement = null;
    gallery.replaceChildren();
    document.getElementById("photoCount").textContent = "";
    updateControls();
    say(id && !saved ? "Save your profile before adding photos." : "");
    if (id && saved) {
      const request = editorRequest + 1;
      loadEditor().catch(() => {
        if (request === editorRequest) say("Photos could not load. Reload this page to try again.", true);
      });
    }
  }

  async function perform(action) {
    if (pending || !ready) return;
    const owner = memberId;
    pending = true;
    updateControls();
    say("Saving photos…");
    try {
      const result = await action();
      if (memberId !== owner) return;
      await loadEditor();
      if (memberId === owner) say(result);
    } catch (error) {
      if (memberId === owner) {
        try { await loadEditor(); } catch { /* Keep the last visible photo list. */ }
        if (memberId === owner) say(error.message || "Photo change could not complete.", true);
      }
    } finally {
      if (memberId === owner) {
        pending = false;
        updateControls();
      }
    }
  }

  async function setPrimary(photo) {
    const { error } = await client.from("profile_photo_preferences").upsert({
      member_id: photo.member_id,
      photo_id: photo.photo_id
    }, { onConflict: "member_id" });
    if (error) throw error;
  }

  async function prepareImage(file) {
    if ((file.type && !fileTypes.has(file.type)) || file.size > 30 * 1024 * 1024) {
      throw new Error("Choose a supported image under 30 MB. JPG, PNG and WebP work on most phones.");
    }
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      throw new Error("This phone could not open that image. Try a JPG, PNG or WebP photo.");
    }
    const canvas = document.createElement("canvas");
    try {
      const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.86));
      if (blob?.type !== "image/jpeg" || blob.size > 6 * 1024 * 1024) {
        throw new Error("Could not prepare this photo. Try a smaller JPG, PNG or WebP.");
      }
      return blob;
    } finally {
      bitmap.close();
    }
  }

  add.onclick = () => openPicker(null);
  picker.onchange = () => {
    const file = picker.files[0];
    const target = replacement;
    const owner = memberId;
    if (!file) return;
    perform(async () => {
      const slot = target?.slot ?? [1, 2, 3, 4, 5].find(number => !photos.some(photo => photo.slot === number));
      if (!slot) throw new Error("You already have five photos. Replace or delete one first.");
      const image = await prepareImage(file);
      if (memberId !== owner) throw new Error("Sign in again to upload a photo.");
      const path = owner + "/" + slot + ".jpg";
      const options = { contentType: "image/jpeg", cacheControl: "0" };
      const { error } = target ? await bucket.update(path, image, options) : await bucket.upload(path, image, options);
      if (error) throw error;
      if (target?.is_preferred && memberId === owner) {
        const updated = (await list([owner])).find(photo => photo.slot === slot);
        if (updated && updated.photo_id !== target.photo_id) await setPrimary(updated);
      }
      return target ? "Photo replaced." : "Photo added.";
    });
  };

  document.getElementById("closeMemberProfile").onclick = () => profileDialog.close();

  async function openProfile(member, details) {
    const request = ++profileRequest;
    dialogTitle.textContent = member.display_name + ", " + member.age;
    const pictures = document.createElement("div");
    pictures.className = "member-gallery";
    pictures.textContent = "Loading photos…";
    dialogBody.replaceChildren(pictures, details.cloneNode(true));
    profileDialog.showModal();
    try {
      const rows = await list([member.id]);
      const urls = await sign(rows);
      if (request !== profileRequest || !profileDialog.open) return;
      pictures.replaceChildren();
      rows.forEach((photo, index) => {
        const url = urls.get(photo.path);
        if (url) pictures.append(photoImage(url, member.display_name + (index === 0 ? " — primary photo" : " — photo " + (index + 1))));
      });
      if (!pictures.childElementCount) pictures.textContent = rows.length ? "Photos are unavailable." : "No photos yet.";
    } catch {
      if (request === profileRequest) pictures.textContent = "Photos could not load.";
    }
  }

  async function showSearchPhotos(cards) {
    const rows = await list(cards.map(({ member }) => member.id));
    const primary = new Map();
    rows.forEach(photo => {
      if (!primary.has(photo.member_id)) primary.set(photo.member_id, photo);
    });
    const urls = await sign([...primary.values()]);
    cards.forEach(({ member, thumbnail }) => {
      const photo = primary.get(member.id);
      if (photo && thumbnail.isConnected) showThumbnail(thumbnail, urls.get(photo.path), member.display_name + " — primary photo");
    });
  }

  function searchCard(member, details) {
    const thumbnail = document.createElement("div");
    thumbnail.className = "member-thumbnail";
    const placeholder = document.createElement("span");
    placeholder.textContent = "♡";
    placeholder.setAttribute("aria-hidden", "true");
    thumbnail.append(placeholder);
    const open = button("View profile", () => openProfile(member, details));
    open.setAttribute("aria-label", "View profile for " + member.display_name);
    return { member, thumbnail, open };
  }

  return { setMember, showSearchPhotos, searchCard };
}
