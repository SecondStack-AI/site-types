// Slides viewer for the `slides` site type. Reads /project/deck.json and /project/slides/<id>.html,
// sanitizes each slide with an allowlist and renders it inline in its own shadow root, and keeps the
// deck fresh through the _spot_deploys event or bounded polling while slides are still missing.
// The package's /_type/slides.json lists the themes a deck picks with theme.preset; ?embed=1 shows
// the stage and a slide strip to a host page that drives it with postMessage (the host protocol).

import DOMPurify from "/_type/vendor/purify.es.js";

const TYPE_NAME = "slides";
const TYPE_VERSION = "1.6.5"; // must equal type.json "version"; repin detection compares against it
const TYPE_ID = `${TYPE_NAME}@${TYPE_VERSION}`;
// The major of slides.json and of the host protocol; a host supports exactly one.
const CONTRACT = 1;
const TYPE_ROOT = "/_type/";
const THEME_ID_RE = /^[a-z0-9-]{1,32}$/;
const UNICODE_RANGE_RE = /^\s*U\+[0-9a-f?]{1,6}(-[0-9a-f]{1,6})?(\s*,\s*U\+[0-9a-f?]{1,6}(-[0-9a-f]{1,6})?)*\s*$/i;
const W = 1920;
const H = 1080;
const DATA_ROOT = "/project/";
const DECK_URL = "/project/deck.json";
const SLIDE_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const LAYOUTS = new Set(["title", "section", "statement", "quote", "center", "image", "split", "blank"]);
const SLIDE_THEMES = new Set(["light", "dark", "accent"]);
const NO_FOOTER_LAYOUTS = new Set(["title", "section", "image", "blank"]);
const TOKENS = ["background", "surface", "foreground", "muted", "accent", "onAccent", "border"];
const FONT_ROLES = ["display", "body", "mono"];
const DECK_KEYS = new Set(["v", "title", "lang", "order", "sections", "theme"]);
const THEME_KEYS = new Set(["preset", "scheme", "light", "dark", "fonts"]);
const POLL_MIN_MS = 2000;
const POLL_MAX_MS = 15000;
const FETCH_CONCURRENCY = 6;

const STRINGS = {
  en: {
    slides: "Slides", previous: "Previous slide", next: "Next slide", overview: "Overview", close: "Close",
    presenter: "Presenter view", fullscreen: "Fullscreen", exitFullscreen: "Exit fullscreen",
    toDark: "Switch to dark theme", toLight: "Switch to light theme", shortcuts: "Keyboard shortcuts",
    print: "Print or save as PDF", slideOf: "Slide {n} of {total}", loading: "Loading presentation…",
    emptyTitle: "No slides yet", emptyBody: "This presentation is still being written. Slides appear here as soon as they are published.",
    deckError: "The presentation could not be loaded", pendingTitle: "This slide is still being written",
    pendingBody: "It appears here as soon as it is published.", slideError: "This slide could not be loaded",
    notes: "Notes", noNotes: "No notes for this slide.", nextUp: "Next", end: "End of presentation",
    elapsed: "Elapsed", pause: "Pause timer", resume: "Resume timer", reset: "Reset timer",
    smaller: "Smaller notes", larger: "Larger notes", blackout: "Black screen", goTo: "Go to slide number",
    firstLast: "First or last slide", stepOf: "Step {n} of {total}",
    updated: "This presentation was updated. Reload the page to see the new version.", reload: "Reload",
    exportPptx: "Download as PowerPoint", exporting: "Exporting slide {n} of {total}…", exportFailed: "The PowerPoint file could not be created",
  },
  de: {
    slides: "Folien", previous: "Vorherige Folie", next: "Nächste Folie", overview: "Übersicht", close: "Schließen",
    presenter: "Referentenansicht", fullscreen: "Vollbild", exitFullscreen: "Vollbild beenden",
    toDark: "Zum dunklen Design wechseln", toLight: "Zum hellen Design wechseln", shortcuts: "Tastenkürzel",
    print: "Drucken oder als PDF speichern", slideOf: "Folie {n} von {total}", loading: "Präsentation wird geladen…",
    emptyTitle: "Noch keine Folien", emptyBody: "Diese Präsentation wird noch erstellt. Folien erscheinen hier, sobald sie veröffentlicht sind.",
    deckError: "Die Präsentation konnte nicht geladen werden", pendingTitle: "Diese Folie wird noch erstellt",
    pendingBody: "Sie erscheint hier, sobald sie veröffentlicht ist.", slideError: "Diese Folie konnte nicht geladen werden",
    notes: "Notizen", noNotes: "Keine Notizen zu dieser Folie.", nextUp: "Als Nächstes", end: "Ende der Präsentation",
    elapsed: "Verstrichen", pause: "Timer anhalten", resume: "Timer fortsetzen", reset: "Timer zurücksetzen",
    smaller: "Kleinere Notizen", larger: "Größere Notizen", blackout: "Schwarzer Bildschirm", goTo: "Zu Foliennummer springen",
    firstLast: "Erste oder letzte Folie", stepOf: "Schritt {n} von {total}",
    updated: "Diese Präsentation wurde aktualisiert. Laden Sie die Seite neu, um die neue Version zu sehen.", reload: "Neu laden",
    exportPptx: "Als PowerPoint herunterladen", exporting: "Folie {n} von {total} wird exportiert…", exportFailed: "Die PowerPoint-Datei konnte nicht erstellt werden",
  },
  es: {
    slides: "Diapositivas", previous: "Diapositiva anterior", next: "Diapositiva siguiente", overview: "Vista general", close: "Cerrar",
    presenter: "Vista del presentador", fullscreen: "Pantalla completa", exitFullscreen: "Salir de pantalla completa",
    toDark: "Cambiar al tema oscuro", toLight: "Cambiar al tema claro", shortcuts: "Atajos de teclado",
    print: "Imprimir o guardar como PDF", slideOf: "Diapositiva {n} de {total}", loading: "Cargando la presentación…",
    emptyTitle: "Aún no hay diapositivas", emptyBody: "Esta presentación todavía se está escribiendo. Las diapositivas aparecen aquí en cuanto se publican.",
    deckError: "No se pudo cargar la presentación", pendingTitle: "Esta diapositiva todavía se está escribiendo",
    pendingBody: "Aparecerá aquí en cuanto se publique.", slideError: "No se pudo cargar esta diapositiva",
    notes: "Notas", noNotes: "Esta diapositiva no tiene notas.", nextUp: "Siguiente", end: "Fin de la presentación",
    elapsed: "Transcurrido", pause: "Pausar el temporizador", resume: "Reanudar el temporizador", reset: "Reiniciar el temporizador",
    smaller: "Notas más pequeñas", larger: "Notas más grandes", blackout: "Pantalla en negro", goTo: "Ir al número de diapositiva",
    firstLast: "Primera o última diapositiva", stepOf: "Paso {n} de {total}",
    updated: "Esta presentación se ha actualizado. Recarga la página para ver la nueva versión.", reload: "Recargar",
    exportPptx: "Descargar como PowerPoint", exporting: "Exportando la diapositiva {n} de {total}…", exportFailed: "No se pudo crear el archivo de PowerPoint",
  },
  fr: {
    slides: "Diapositives", previous: "Diapositive précédente", next: "Diapositive suivante", overview: "Vue d’ensemble", close: "Fermer",
    presenter: "Mode présentateur", fullscreen: "Plein écran", exitFullscreen: "Quitter le plein écran",
    toDark: "Passer au thème sombre", toLight: "Passer au thème clair", shortcuts: "Raccourcis clavier",
    print: "Imprimer ou enregistrer en PDF", slideOf: "Diapositive {n} sur {total}", loading: "Chargement de la présentation…",
    emptyTitle: "Pas encore de diapositives", emptyBody: "Cette présentation est en cours de rédaction. Les diapositives apparaissent ici dès leur publication.",
    deckError: "La présentation n’a pas pu être chargée", pendingTitle: "Cette diapositive est en cours de rédaction",
    pendingBody: "Elle apparaîtra ici dès sa publication.", slideError: "Cette diapositive n’a pas pu être chargée",
    notes: "Notes", noNotes: "Aucune note pour cette diapositive.", nextUp: "Suivante", end: "Fin de la présentation",
    elapsed: "Écoulé", pause: "Mettre le minuteur en pause", resume: "Reprendre le minuteur", reset: "Réinitialiser le minuteur",
    smaller: "Notes plus petites", larger: "Notes plus grandes", blackout: "Écran noir", goTo: "Aller au numéro de diapositive",
    firstLast: "Première ou dernière diapositive", stepOf: "Étape {n} sur {total}",
    updated: "Cette présentation a été mise à jour. Rechargez la page pour voir la nouvelle version.", reload: "Recharger",
    exportPptx: "Télécharger au format PowerPoint", exporting: "Export de la diapositive {n} sur {total}…", exportFailed: "Le fichier PowerPoint n’a pas pu être créé",
  },
  pl: {
    slides: "Slajdy", previous: "Poprzedni slajd", next: "Następny slajd", overview: "Przegląd", close: "Zamknij",
    presenter: "Widok prezentera", fullscreen: "Pełny ekran", exitFullscreen: "Zamknij pełny ekran",
    toDark: "Przełącz na ciemny motyw", toLight: "Przełącz na jasny motyw", shortcuts: "Skróty klawiszowe",
    print: "Drukuj lub zapisz jako PDF", slideOf: "Slajd {n} z {total}", loading: "Wczytywanie prezentacji…",
    emptyTitle: "Brak slajdów", emptyBody: "Ta prezentacja jest jeszcze przygotowywana. Slajdy pojawią się tutaj zaraz po opublikowaniu.",
    deckError: "Nie udało się wczytać prezentacji", pendingTitle: "Ten slajd jest jeszcze przygotowywany",
    pendingBody: "Pojawi się tutaj zaraz po opublikowaniu.", slideError: "Nie udało się wczytać tego slajdu",
    notes: "Notatki", noNotes: "Brak notatek do tego slajdu.", nextUp: "Następny", end: "Koniec prezentacji",
    elapsed: "Upłynęło", pause: "Wstrzymaj stoper", resume: "Wznów stoper", reset: "Wyzeruj stoper",
    smaller: "Mniejsze notatki", larger: "Większe notatki", blackout: "Czarny ekran", goTo: "Przejdź do slajdu o numerze",
    firstLast: "Pierwszy lub ostatni slajd", stepOf: "Krok {n} z {total}",
    updated: "Ta prezentacja została zaktualizowana. Odśwież stronę, aby zobaczyć nową wersję.", reload: "Odśwież",
    exportPptx: "Pobierz jako PowerPoint", exporting: "Eksportowanie slajdu {n} z {total}…", exportFailed: "Nie udało się utworzyć pliku PowerPoint",
  },
  ru: {
    slides: "Слайды", previous: "Предыдущий слайд", next: "Следующий слайд", overview: "Обзор", close: "Закрыть",
    presenter: "Режим докладчика", fullscreen: "Полный экран", exitFullscreen: "Выйти из полноэкранного режима",
    toDark: "Включить тёмную тему", toLight: "Включить светлую тему", shortcuts: "Сочетания клавиш",
    print: "Печать или сохранение в PDF", slideOf: "Слайд {n} из {total}", loading: "Загрузка презентации…",
    emptyTitle: "Слайдов пока нет", emptyBody: "Эта презентация ещё готовится. Слайды появятся здесь сразу после публикации.",
    deckError: "Не удалось загрузить презентацию", pendingTitle: "Этот слайд ещё готовится",
    pendingBody: "Он появится здесь сразу после публикации.", slideError: "Не удалось загрузить этот слайд",
    notes: "Заметки", noNotes: "К этому слайду нет заметок.", nextUp: "Далее", end: "Конец презентации",
    elapsed: "Прошло", pause: "Приостановить таймер", resume: "Продолжить таймер", reset: "Сбросить таймер",
    smaller: "Уменьшить заметки", larger: "Увеличить заметки", blackout: "Чёрный экран", goTo: "Перейти к слайду по номеру",
    firstLast: "Первый или последний слайд", stepOf: "Шаг {n} из {total}",
    updated: "Эта презентация обновлена. Перезагрузите страницу, чтобы увидеть новую версию.", reload: "Перезагрузить",
    exportPptx: "Скачать в формате PowerPoint", exporting: "Экспорт слайда {n} из {total}…", exportFailed: "Не удалось создать файл PowerPoint",
  },
};

const UI_LANG = (navigator.languages || [navigator.language || "en"])
  .map((tag) => String(tag).toLowerCase().split("-")[0])
  .find((code) => code in STRINGS) || "en";

function t(key, vars) {
  const text = STRINGS[UI_LANG][key] ?? STRINGS.en[key] ?? key;
  return vars ? text.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? "")) : text;
}

const ICONS = {
  prev: '<path d="M15 18l-6-6 6-6"/>',
  next: '<path d="M9 18l6-6-6-6"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
  presenter: '<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8 21h8M12 17v4M6.5 8.5h6M6.5 12h4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/>',
  moon: '<path d="M20.5 14.2A8.5 8.5 0 1 1 9.8 3.5a6.8 6.8 0 0 0 10.7 10.7z"/>',
  expand: '<path d="M8 3.5H5.5a2 2 0 0 0-2 2V8M20.5 8V5.5a2 2 0 0 0-2-2H16M3.5 16v2.5a2 2 0 0 0 2 2H8M16 20.5h2.5a2 2 0 0 0 2-2V16"/>',
  shrink: '<path d="M8 3.5V6a2 2 0 0 1-2 2H3.5M20.5 8H18a2 2 0 0 1-2-2V3.5M3.5 16H6a2 2 0 0 1 2 2v2.5M16 20.5V18a2 2 0 0 1 2-2h2.5"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.6"/><path d="M12 16.8v.1"/>',
  print: '<path d="M6.5 9V3.5h11V9"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6.5 14h11v6.5h-11z"/>',
  download: '<path d="M12 3.5v11M7.5 10l4.5 4.5 4.5-4.5M4 16.5v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  close: '<path d="M18 6L6 18M6 6l12 12"/>',
  pause: '<path d="M8.5 5v14M15.5 5v14"/>',
  play: '<path d="M7.5 5.5l11 6.5-11 6.5z"/>',
  reset: '<path d="M3.5 12a8.5 8.5 0 1 0 2.8-6.3L3.5 8.3"/><path d="M3.5 3.5v4.8h4.8"/>',
};

function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function icon(name) {
  const span = document.createElement("span");
  span.style.display = "contents";
  span.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
  return span.firstChild;
}

function iconButton(name, label, onclick, extraClass) {
  return h("button", { type: "button", class: `icon-btn ${extraClass || ""}`, "aria-label": label, title: label, onclick }, icon(name));
}

// The hash is "<slide id>" or "<slide id>.<step>"; slide ids have no dots.
function parseHash() {
  let raw;
  try {
    raw = decodeURIComponent(location.hash.slice(1));
  } catch {
    return { id: null, step: 0 };
  }
  const match = /^([\s\S]*?)(?:\.(\d{1,3}))?$/.exec(raw);
  return { id: match[1] || null, step: match[2] ? Number(match[2]) : 0 };
}
const initialHash = parseHash();

const params = new URLSearchParams(location.search);
const CHECK = params.get("check") === "1";
const PRESENTER = params.get("presenter") === "1";
const EMBED = params.get("embed") === "1" && !CHECK && !PRESENTER;
const THUMBNAIL = params.get("thumb") === "1" && !CHECK && !PRESENTER;
const HOST_ORIGIN = EMBED || PRESENTER ? hostOrigin(params.get("host")) : null;
const app = document.getElementById("app");

// The host parameter must be exactly an http(s) origin: it is the only origin the viewer talks to.
function hostOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value ? value : null;
}
if (EMBED && !HOST_ORIGIN) console.error(`[slides] embed=1 needs host=<origin of the host page>, got ${JSON.stringify(params.get("host"))}; the host protocol is off`);
document.documentElement.lang = UI_LANG;

const state = {
  deckStatus: "loading", // loading | missing | invalid | ok
  deckError: "",
  deckText: null,
  deck: null, // normalized deck
  deckIssues: [],
  slides: new Map(), // id -> slide record
  index: 0,
  step: 0, // steps of the current slide revealed so far
  pendingId: initialHash.id,
  pendingStep: initialHash.step,
  scheme: "light",
  blackout: false,
};

let slideSheet = null;

function issue(level, code, message, extra) {
  return { level, code, message, ...(extra || {}) };
}

function validColor(value) {
  return typeof value === "string" && value.length <= 120 && CSS.supports("color", value);
}

function normalizeDeck(raw) {
  const issues = [];
  const deck = { title: "", lang: null, order: [], sections: [], theme: { preset: null, scheme: null, light: {}, dark: {}, fonts: {} } };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    issues.push(issue("error", "deck-not-object", "deck.json must be a JSON object"));
    return { deck, issues };
  }
  for (const key of Object.keys(raw)) {
    if (!DECK_KEYS.has(key)) issues.push(issue("warning", "deck-key-unknown", `Unknown key "${key}" in deck.json is ignored`));
  }
  if (raw.v !== 1) issues.push(issue("error", "deck-version", `deck.json "v" must be 1, got ${JSON.stringify(raw.v)}`));
  if (typeof raw.title === "string") deck.title = raw.title.trim();
  else issues.push(issue("warning", "deck-title", 'deck.json has no "title" string'));
  if (raw.lang != null) {
    if (typeof raw.lang === "string" && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(raw.lang)) deck.lang = raw.lang;
    else issues.push(issue("warning", "deck-lang", `"lang" must be a language tag such as "en" or "de-DE"`));
  }

  if (!Array.isArray(raw.order)) {
    issues.push(issue("error", "order-missing", 'deck.json "order" must be an array of slide ids'));
  } else {
    const seen = new Set();
    for (const id of raw.order) {
      if (typeof id !== "string" || !SLIDE_ID_RE.test(id)) {
        issues.push(issue("error", "slide-id-invalid", `Slide id ${JSON.stringify(id)} must be 1-64 lowercase letters, digits and inner hyphens`));
      } else if (seen.has(id)) {
        issues.push(issue("error", "slide-id-duplicate", `Slide id "${id}" is listed twice in "order"`, { slide: id }));
      } else {
        seen.add(id);
        deck.order.push(id);
      }
    }
  }

  if (raw.sections != null) {
    if (typeof raw.sections !== "object" || Array.isArray(raw.sections)) {
      issues.push(issue("error", "sections-invalid", '"sections" must be an object of section id to {title, start}'));
    } else {
      const starts = new Map();
      for (const [key, value] of Object.entries(raw.sections)) {
        const start = value && typeof value === "object" ? value.start : undefined;
        const at = deck.order.indexOf(start);
        if (typeof value?.title !== "string" || !value.title.trim()) {
          issues.push(issue("error", "section-title", `Section "${key}" needs a "title" string`));
        } else if (at < 0) {
          issues.push(issue("error", "section-start-unknown", `Section "${key}" starts at "${start}", which is not in "order"`));
        } else if (starts.has(at)) {
          issues.push(issue("error", "section-start-duplicate", `Sections "${starts.get(at)}" and "${key}" start at the same slide`));
        } else {
          starts.set(at, key);
          deck.sections.push({ id: key, title: value.title.trim(), start: at });
        }
      }
      deck.sections.sort((a, b) => a.start - b.start);
    }
  }

  const theme = raw.theme;
  if (theme != null) {
    if (typeof theme !== "object" || Array.isArray(theme)) {
      issues.push(issue("warning", "theme-invalid", '"theme" must be an object'));
    } else {
      for (const key of Object.keys(theme)) {
        if (!THEME_KEYS.has(key)) issues.push(issue("warning", "theme-key-unknown", `Unknown theme key "${key}" is ignored`));
      }
      if (theme.preset != null) {
        if (themes.has(theme.preset)) deck.theme.preset = theme.preset;
        else issues.push(issue("error", "unknown-preset", `theme "preset" ${JSON.stringify(theme.preset)} is not a theme of this site type, so the deck shows "${defaultThemeId}"; known: ${[...themes.keys()].join(", ")}`));
      }
      if (theme.scheme != null) {
        if (theme.scheme === "light" || theme.scheme === "dark") deck.theme.scheme = theme.scheme;
        else issues.push(issue("warning", "theme-scheme", 'theme "scheme" must be "light" or "dark"'));
      }
      for (const scheme of ["light", "dark"]) {
        const tokens = theme[scheme];
        if (tokens == null) continue;
        if (typeof tokens !== "object" || Array.isArray(tokens)) {
          issues.push(issue("warning", "theme-tokens", `theme "${scheme}" must be an object of colors`));
          continue;
        }
        for (const [name, value] of Object.entries(tokens)) {
          if (!TOKENS.includes(name)) issues.push(issue("warning", "theme-token-unknown", `Unknown ${scheme} token "${name}"; known tokens: ${TOKENS.join(", ")}`));
          else if (!validColor(value)) issues.push(issue("warning", "theme-color-invalid", `${scheme}.${name} is not a CSS color: ${JSON.stringify(value)}`));
          else deck.theme[scheme][name] = value;
        }
      }
      if (theme.fonts != null) {
        if (typeof theme.fonts !== "object" || Array.isArray(theme.fonts)) {
          issues.push(issue("warning", "theme-fonts", 'theme "fonts" must be an object'));
        } else {
          for (const [role, spec] of Object.entries(theme.fonts)) {
            if (!FONT_ROLES.includes(role)) {
              issues.push(issue("warning", "font-role-unknown", `Unknown font role "${role}"; known roles: ${FONT_ROLES.join(", ")}`));
              continue;
            }
            const font = normalizeFont(role, spec, issues);
            if (font) deck.theme.fonts[role] = font;
          }
        }
      }
    }
  }
  return { deck, issues };
}

const FONT_STYLESHEET_ORIGIN = "https://fonts.googleapis.com";
const FONT_FILE_ORIGINS = ["https://fonts.gstatic.com", "https://fonts.googleapis.com"];

function fontStylesheetUrl(value) {
  try {
    const url = new URL(String(value));
    return url.origin === FONT_STYLESHEET_ORIGIN ? url.href : null;
  } catch {
    return null;
  }
}

function fontFaceUrl(value) {
  const url = typeof value === "string" ? resourceUrl(value) : null;
  if (!url || url.startsWith(DATA_ROOT)) return url;
  return FONT_FILE_ORIGINS.includes(new URL(url).origin) ? url : null;
}

// FontFace() throws on an invalid weight descriptor, which would stop the whole viewer.
function fontWeight(value, role, issues) {
  if (value == null) return "400";
  const weight = String(value).trim();
  if (/^(normal|bold|(1000|[1-9]\d{0,2})( (1000|[1-9]\d{0,2}))?)$/.test(weight)) return weight;
  issues.push(issue("warning", "font-weight", `fonts.${role}.faces weight ${JSON.stringify(value)} is not a CSS weight such as 400 or "100 900"; 400 is used`));
  return "400";
}

// A path inside the package, served under /_type/.
function typeFileUrl(value) {
  if (typeof value !== "string" || !value || /^[a-z][a-z0-9+.-]*:|^\/|\\/i.test(value)) return null;
  const url = new URL(value, location.origin + TYPE_ROOT);
  return url.origin === location.origin && url.pathname.startsWith(TYPE_ROOT) && !url.search && !url.hash ? url.pathname : null;
}

// Deck fonts load from project/ or Google Fonts; theme fonts (`fromType`) load from the package and
// may split a family into unicode-range subsets.
function normalizeFont(role, spec, issues, { fromType = false } = {}) {
  if (!spec || typeof spec !== "object" || typeof spec.family !== "string" || !spec.family.trim() || spec.family.length > 100) {
    issues.push(issue("warning", "font-family", `fonts.${role} needs a "family" string`));
    return null;
  }
  const font = { family: spec.family.trim(), href: null, faces: [], fromType };
  if (spec.href != null) {
    if (fontStylesheetUrl(spec.href)) font.href = fontStylesheetUrl(spec.href);
    else issues.push(issue("warning", "font-href", `fonts.${role}.href must be a ${FONT_STYLESHEET_ORIGIN}/ stylesheet URL`));
  }
  if (spec.faces != null) {
    if (!Array.isArray(spec.faces)) {
      issues.push(issue("warning", "font-faces", `fonts.${role}.faces must be an array`));
    } else {
      for (const face of spec.faces) {
        const src = fromType ? typeFileUrl(face?.src) : fontFaceUrl(face?.src);
        if (!src) {
          issues.push(issue("warning", "font-face-src", fromType
            ? `Each fonts.${role}.faces entry needs a "src" relative to the package root`
            : `Each fonts.${role}.faces entry needs a "src" under project/ or on ${FONT_FILE_ORIGINS.join(" or ")}`));
          continue;
        }
        const entry = { src, weight: fontWeight(face.weight, role, issues), style: face.style === "italic" ? "italic" : "normal", unicodeRange: null };
        if (fromType && face.unicodeRange != null) {
          if (typeof face.unicodeRange === "string" && UNICODE_RANGE_RE.test(face.unicodeRange)) entry.unicodeRange = face.unicodeRange.trim();
          else issues.push(issue("warning", "font-unicode-range", `fonts.${role}.faces unicodeRange ${JSON.stringify(face.unicodeRange)} is not a CSS unicode-range such as "U+0000-00FF, U+0131"`));
        }
        font.faces.push(entry);
      }
    }
  }
  return font;
}

// The package's themes, from /_type/slides.json. A fork replaces that file and its assets, not this
// code. A problem in it is a package bug: check mode reports it as an error on every deck, and a theme
// that fails to load is left out.
const themes = new Map(); // id -> { id, scheme, light, dark, fonts, stylesheet }
const themeSheets = new Map(); // id -> CSSStyleSheet
const typeIssues = [];
let defaultThemeId = null;
let activeThemeId = null;

function normalizeThemes(raw) {
  const bad = (message) => typeIssues.push(issue("error", "slides-json-invalid", `_type/slides.json: ${message}`));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad("must be a JSON object");
  if (raw.contract !== CONTRACT) bad(`"contract" must be ${CONTRACT}, got ${JSON.stringify(raw.contract)}`);
  if (!Array.isArray(raw.themes) || !raw.themes.length) return bad('"themes" must be a non-empty array');
  raw.themes.forEach((entry, at) => {
    const where = `themes[${at}]`;
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || !THEME_ID_RE.test(entry.id)) return bad(`${where}.id must be 1-32 lowercase letters, digits and hyphens`);
    if (themes.has(entry.id)) return bad(`theme "${entry.id}" is listed twice`);
    const theme = { id: entry.id, scheme: entry.scheme, light: {}, dark: {}, fonts: {}, stylesheet: null };
    for (const key of ["title", "description"]) {
      if (typeof entry[key] !== "string" || !entry[key].trim()) bad(`${where}.${key} must be a non-empty string`);
    }
    if (entry.scheme !== "light" && entry.scheme !== "dark") {
      bad(`${where}.scheme must be "light" or "dark"`);
      theme.scheme = "light";
    }
    for (const scheme of ["light", "dark"]) {
      for (const name of TOKENS) {
        const value = entry.colors?.[scheme]?.[name];
        if (validColor(value)) theme[scheme][name] = value;
        else bad(`${where}.colors.${scheme}.${name} must be a CSS color, got ${JSON.stringify(value)}`);
      }
    }
    if (entry.fonts != null) {
      const fontIssues = [];
      for (const [role, spec] of Object.entries(entry.fonts)) {
        if (!FONT_ROLES.includes(role)) fontIssues.push(issue("warning", "font-role-unknown", `unknown font role "${role}"`));
        const font = FONT_ROLES.includes(role) ? normalizeFont(role, spec, fontIssues, { fromType: true }) : null;
        if (font) theme.fonts[role] = font;
      }
      for (const item of fontIssues) bad(`${where}: ${item.message}`);
    }
    if (entry.stylesheet != null) {
      theme.stylesheet = /\.css$/i.test(entry.stylesheet) ? typeFileUrl(entry.stylesheet) : null;
      if (!theme.stylesheet) bad(`${where}.stylesheet must be a .css file relative to the package root`);
    }
    if (typeof entry.preview !== "string" || !/\.(svg|png)$/i.test(entry.preview) || !typeFileUrl(entry.preview)) bad(`${where}.preview must be an .svg or .png file relative to the package root`);
    themes.set(theme.id, theme);
  });
  if (themes.has(raw.defaultTheme)) defaultThemeId = raw.defaultTheme;
  else bad(`"defaultTheme" ${JSON.stringify(raw.defaultTheme)} is not a theme id`);
}

async function loadThemes() {
  const response = await fetch(`${TYPE_ROOT}slides.json`);
  if (!response.ok) return typeIssues.push(issue("error", "slides-json-invalid", `_type/slides.json: HTTP ${response.status}`));
  let raw;
  try {
    raw = JSON.parse(await response.text());
  } catch (error) {
    return typeIssues.push(issue("error", "slides-json-invalid", `_type/slides.json is not valid JSON: ${error.message}`));
  }
  normalizeThemes(raw);
  // Every stylesheet loads up front, so a preset change after a deploy applies at once.
  await Promise.all([...themes.values()].filter((theme) => theme.stylesheet).map(async (theme) => {
    const sheetResponse = await fetch(theme.stylesheet);
    if (!sheetResponse.ok) {
      typeIssues.push(issue("error", "slides-json-invalid", `${theme.stylesheet}: HTTP ${sheetResponse.status}`));
      return;
    }
    const sheet = new CSSStyleSheet({ baseURL: new URL(theme.stylesheet, location.origin).href });
    sheet.replaceSync(await sheetResponse.text());
    themeSheets.set(theme.id, sheet);
  }));
}

// Inline slide HTML stays declarative: one slide is mounted several times at once (stage, overview,
// presenter, print, check), so its scripts would run in every copy and fight the deck for keys and ids.
// DOMPurify keeps an allowlist of inert markup and the hook below applies the URL policy: links are
// http(s), mailto or relative; resources are /project/ files, https or data: images.
// Interactivity lives in iframes. A /project/ page has the site's own authority, as script in an
// untyped site's data does (design: "Owners and agents write data only"); a cross-origin https page is
// isolated by the browser's same-origin policy. Both keep their own origin, so apps can use the Spot
// SDK and embeds can use storage. A same-origin app is fully trusted with the deck, its DOM and its
// navigation included (it can script its parent); only a cross-origin frame is kept from navigating it.
const IFRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads";
const PURIFY_CONFIG = {
  ADD_TAGS: ["iframe", "use"],
  ADD_ATTR: ["allow", "allowfullscreen", "frameborder", "loading", "referrerpolicy", "target"],
  FORBID_TAGS: [
    "object", "embed", "applet", "frame", "frameset", "form", "base", "meta", "link", "script", "noscript",
    "portal", "fencedframe", "animate", "animateMotion", "animateTransform", "animateColor", "set", "discard",
  ],
  FORBID_ATTR: ["srcdoc", "action", "formaction", "formmethod", "formtarget", "formenctype", "ping", "background"],
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
  RETURN_DOM_FRAGMENT: true,
};
const URL_PRESENTATION_ATTRS = ["fill", "stroke", "filter", "mask", "clip-path", "marker-start", "marker-mid", "marker-end", "cursor"];
const purify = DOMPurify(window);
let hookRemovals = [];

function resourceUrl(value, { dataImage = false } = {}) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (dataImage && /^data:image\//i.test(raw)) return raw;
  let url;
  try {
    url = new URL(raw, location.origin + DATA_ROOT);
  } catch {
    return null;
  }
  if (url.origin === location.origin) return url.pathname.startsWith(DATA_ROOT) ? url.pathname + url.search + url.hash : null;
  return url.protocol === "https:" ? url.href : null;
}

function linkUrl(value) {
  const raw = String(value ?? "").trim();
  if (raw.startsWith("#")) return raw;
  let url;
  try {
    url = new URL(raw, location.origin + DATA_ROOT);
  } catch {
    return null;
  }
  if (!["http:", "https:", "mailto:"].includes(url.protocol)) return null;
  return url.origin === location.origin ? url.pathname + url.search + url.hash : url.href;
}

// Finds url(...) tokens in a CSS value; a token is null when it cannot be read unambiguously.
function cssUrlTokens(value) {
  const tokens = [];
  const re = /(^|[^\w-])url\(/gi;
  for (let match = re.exec(value); match; match = re.exec(value)) {
    const start = match.index + match[1].length;
    let i = re.lastIndex;
    while (/\s/.test(value[i] ?? "")) i += 1;
    let url = "";
    const quote = value[i] === '"' || value[i] === "'" ? value[i] : "";
    if (quote) {
      const close = value.indexOf(quote, i + 1);
      if (close < 0) return [null];
      url = value.slice(i + 1, close);
      i = close + 1;
      while (/\s/.test(value[i] ?? "")) i += 1;
      if (value[i] !== ")") return [null];
    } else {
      const close = value.indexOf(")", i);
      if (close < 0) return [null];
      url = value.slice(i, close).trim();
      i = close;
    }
    if (url.includes("\\")) return [null];
    tokens.push({ start, end: i + 1, url });
    re.lastIndex = i + 1;
  }
  return tokens;
}

// Returns the value with every url() made canonical, or null when the declaration must be dropped.
// Escapes are refused: custom properties keep them until var() substitution, where u\72l( becomes url(.
function sanitizeCssValue(value) {
  if (value.includes("\\")) return null;
  if (/image-set\(|(^|[^\w-])(image|element|src)\(/i.test(value)) return null;
  let out = "";
  let at = 0;
  for (const token of cssUrlTokens(value)) {
    if (token === null) return null;
    const url = token.url.startsWith("#") ? token.url : resourceUrl(token.url, { dataImage: true });
    if (url === null) return null;
    out += `${value.slice(at, token.start)}url("${url.replace(/["\n]/g, encodeURIComponent)}")`;
    at = token.end;
  }
  return out + value.slice(at);
}

function sanitizeDeclarations(style) {
  let removed = 0;
  for (let i = style.length - 1; i >= 0; i -= 1) {
    const name = style[i];
    const value = style.getPropertyValue(name);
    if (!/[(\\]/.test(value)) continue;
    const clean = sanitizeCssValue(value);
    if (clean === null) {
      style.removeProperty(name);
      removed += 1;
    } else if (clean !== value) {
      style.setProperty(name, clean, style.getPropertyPriority(name));
    }
  }
  return removed;
}

// Parses slide CSS with the browser's own parser; a constructed sheet ignores @import rules. The
// warning parses the same text in an inert document, which loads nothing.
function sanitizeStylesheet(cssText, issues) {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(cssText);
  const probe = document.implementation.createHTMLDocument("").head.appendChild(document.createElement("style"));
  probe.textContent = cssText;
  if ([...(probe.sheet?.cssRules || [])].some((rule) => rule instanceof CSSImportRule)) {
    issues.push(issue("warning", "css-import-removed", "@import is not supported in slides and was ignored"));
  }
  let removed = 0;
  const walk = (rules) => {
    for (const rule of rules) {
      if (rule.style) removed += sanitizeDeclarations(rule.style);
      if (rule.cssRules) walk(rule.cssRules);
    }
  };
  walk(sheet.cssRules);
  if (removed) issues.push(issue("warning", "css-url-removed", `${removed} CSS declaration(s) removed: url() must point to project/ files, https or data: images, and values cannot use escapes`));
  return sheet;
}

// While a hand edit is sanitized for its file, the hook only removes: it keeps the author's relative
// URLs and adds no attributes that exist for rendering (iframe sandbox, link target).
let sanitizingFile = false;

function rewriteAttr(node, name, fn) {
  const attr = node.getAttributeNode(name);
  if (!attr) return;
  const value = fn(attr.value);
  if (value === null) {
    node.removeAttributeNode(attr);
    hookRemovals.push(`${name}="${attr.value.slice(0, 60)}"`);
  } else if (value !== attr.value && !sanitizingFile) {
    attr.value = value;
  }
}

purify.addHook("afterSanitizeAttributes", (node) => {
  const isLink = node.localName === "a" || node.localName === "area";
  const fragmentOnly = node.localName === "use";
  for (const name of ["href", "xlink:href"]) {
    rewriteAttr(node, name, (value) => {
      const trimmed = value.trim();
      if (isLink) return linkUrl(value);
      if (trimmed.startsWith("#")) return trimmed;
      return fragmentOnly ? null : resourceUrl(value);
    });
  }
  const dataImage = node.localName === "img" || node.localName === "source";
  rewriteAttr(node, "src", (value) => resourceUrl(value, { dataImage }));
  rewriteAttr(node, "poster", (value) => resourceUrl(value, { dataImage: true }));
  rewriteAttr(node, "srcset", (value) => {
    const parts = value.split(",").map((part) => {
      const [url, ...rest] = part.trim().split(/\s+/);
      const clean = resourceUrl(url, { dataImage });
      return clean === null ? null : [clean, ...rest].join(" ");
    });
    return parts.includes(null) ? null : parts.join(", ");
  });
  for (const name of URL_PRESENTATION_ATTRS) {
    rewriteAttr(node, name, (value) => value.includes("\\") || (/url\(/i.test(value) && !/^\s*url\(\s*["']?#[^)]*\)\s*$/i.test(value)) ? null : value);
  }
  if (node.hasAttribute("style")) {
    const scratch = document.createElement("div");
    scratch.setAttribute("style", node.getAttribute("style"));
    const removed = sanitizeDeclarations(scratch.style);
    if (removed) hookRemovals.push("style declaration with url() or escapes");
    if (removed || !sanitizingFile) node.setAttribute("style", scratch.style.cssText);
  }
  if (node.localName === "iframe") {
    if (!sanitizingFile) node.setAttribute("sandbox", IFRAME_SANDBOX);
    rewriteAttr(node, "data-poster", (value) => resourceUrl(value, { dataImage: true }));
  }
  if (sanitizingFile) return;
  if (isLink && /^https?:\/\//i.test(node.getAttribute("href") || "")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  } else {
    node.removeAttribute("target");
  }
});

function sanitizeSection(section, issues) {
  hookRemovals = [];
  const clean = purify.sanitize(section, PURIFY_CONFIG);
  const removed = [
    ...purify.removed.map((item) => {
      if (item.element) return item.element.nodeName.startsWith("#") ? null : `<${item.element.localName}>`;
      return item.attribute ? `${item.attribute.name}="${item.attribute.value.slice(0, 60)}"` : null;
    }),
    ...hookRemovals,
  ].filter(Boolean);
  if (removed.length) {
    issues.push(issue("warning", "unsafe-removed", `Removed for safety (slides run no scripts and load only allowed URLs): ${[...new Set(removed)].join(", ")}`));
  }
  return clean;
}

const STEP_RE = /^\s*[1-9]\d{0,2}\s*$/;
const NODE_ATTR = "data-slides-node";

// Builds: data-step="N" puts an element in step N, and elements with the same number are revealed
// together. Numbers only order the steps, so data-step 2 and 5 are steps 1 and 2. An element whose
// data-step is empty or not a number is always shown, and so is the slide's own section: `section` is
// searched, not included. Only the new attribute opts in: markup that 1.0.0 decks may already use,
// such as a "step" class, must keep rendering as before.
function slideSteps(section) {
  const numbered = [];
  for (const el of section.querySelectorAll("[data-step]")) {
    const raw = el.getAttribute("data-step");
    if (STEP_RE.test(raw)) numbered.push({ el, n: Number(raw) });
  }
  const values = [...new Set(numbered.map((item) => item.n))].sort((a, b) => a - b);
  return { count: values.length, items: numbered.map(({ el, n }) => ({ el, step: values.indexOf(n) + 1 })) };
}

// Steps after `step` wait hidden: data-step-hidden is the hook for the reveal styles in slide.css, and
// inert keeps a waiting step out of the tab order and the accessibility tree even when a slide restyles
// it as visible. Returns the elements this call revealed.
function applySteps(frame, step) {
  const revealed = [];
  const section = frame.querySelector(":scope > section");
  if (!section) return revealed;
  for (const item of slideSteps(section).items) {
    const hidden = item.step > step;
    if (!hidden && item.el.hasAttribute("data-step-hidden")) revealed.push(item.el);
    item.el.toggleAttribute("data-step-hidden", hidden);
    item.el.toggleAttribute("inert", hidden);
  }
  return revealed;
}

// What a step revealed, for the live region: the text of the outermost revealed elements, without the
// nested steps that are still waiting.
function revealedText(elements) {
  return elements
    .filter((el) => !elements.some((other) => other !== el && other.contains(el)))
    .map((el) => {
      const copy = el.cloneNode(true);
      for (const waiting of copy.querySelectorAll("[data-step-hidden]")) waiting.remove();
      return copy.textContent.replace(/\s+/g, " ").trim();
    })
    .filter(Boolean)
    .join(" ");
}

function parseSlide(id, text) {
  const issues = [];
  const doc = new DOMParser().parseFromString(text, "text/html");
  const body = doc.body;
  const topElements = [...body.children];
  const sections = topElements.filter((node) => node.localName === "section");
  const strayText = [...body.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
  const headStyles = [...doc.head.querySelectorAll("style")].map((node) => node.textContent);
  let section = sections[0];
  // Every element of the file's section is numbered in document order, so a hand edit on the stage can
  // be written back into the file's own markup (editSlideFile).
  section?.querySelectorAll("*").forEach((el, at) => el.setAttribute(NODE_ATTR, String(at)));

  if (!section) {
    issues.push(issue("error", "no-section", "The file must contain one <section> element"));
    section = doc.createElement("section");
    section.append(...body.childNodes);
  } else {
    if (sections.length > 1) issues.push(issue("error", "multiple-sections", `The file has ${sections.length} <section> elements; only the first is shown`));
    const others = topElements.filter((node) => node.localName !== "section");
    if (others.length || strayText) {
      const names = others.map((node) => `<${node.localName}>`).join(", ") || "text";
      issues.push(issue("error", "content-outside-section", `Content outside the <section> is ignored: ${names}`));
    }
  }
  if (headStyles.length || doc.head.querySelector("link")) {
    issues.push(issue("warning", "style-outside-section", "Put <style> inside the <section>; styles before it are applied anyway, linked stylesheets are not"));
  }

  let notes = "";
  const last = section.lastElementChild;
  if (last && last.localName === "aside") {
    if (last.children.length) issues.push(issue("warning", "notes-markup", "Speaker notes are plain text; markup inside <aside> is dropped"));
    notes = last.textContent.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
    last.remove();
  }
  if (section.querySelector(":scope > aside")) {
    issues.push(issue("warning", "notes-not-last", "An <aside> that is not the last child is shown on the slide, not used as notes"));
  }

  const layout = section.getAttribute("data-layout");
  if (layout && !LAYOUTS.has(layout)) issues.push(issue("warning", "layout-unknown", `Unknown data-layout "${layout}"; known: ${[...LAYOUTS].join(", ")}`));
  const theme = section.getAttribute("data-theme");
  if (theme && !SLIDE_THEMES.has(theme)) issues.push(issue("warning", "slide-theme-unknown", `Unknown data-theme "${theme}"; known: ${[...SLIDE_THEMES].join(", ")}`));

  // Slide CSS goes only to sanitizeStylesheet; DOMPurify would drop a whole <style> whose text has "<".
  const styleTexts = [...headStyles];
  for (const node of section.querySelectorAll("style")) {
    styleTexts.push(node.textContent);
    node.remove();
  }
  const clean = sanitizeSection(section, issues);
  const sheets = styleTexts.length ? [sanitizeStylesheet(styleTexts.join("\n"), issues)] : [];
  const cleanSection = clean.querySelector("section") || clean;
  const invalidSteps = [...cleanSection.querySelectorAll("[data-step]")].filter((el) => !STEP_RE.test(el.getAttribute("data-step")));
  if (invalidSteps.length) {
    issues.push(issue("warning", "step-invalid", `data-step must be a whole number from 1 to 999; ${invalidSteps.length} element(s) without one are always shown`));
  }
  if (cleanSection.hasAttribute("data-step")) {
    issues.push(issue("warning", "step-on-section", "data-step on the <section> is ignored; put it on elements inside the slide"));
  }
  const titleSource = (cleanSection.querySelector("h1, h2, h3") || cleanSection).cloneNode(true);
  for (const br of titleSource.querySelectorAll("br")) br.replaceWith(" ");
  const title = titleSource.textContent.replace(/\s+/g, " ").trim().slice(0, 120) || id;
  return {
    status: issues.some((item) => item.level === "error") ? "malformed" : "ok",
    fragment: document.importNode(clean, true),
    sheets,
    layout: LAYOUTS.has(layout) ? layout : null,
    theme: SLIDE_THEMES.has(theme) ? theme : null,
    footer: section.getAttribute("data-footer"),
    title,
    notes,
    steps: slideSteps(cleanSection).count,
    issues,
  };
}

async function fetchText(url) {
  const response = await fetch(url, { cache: "no-store", credentials: "same-origin" });
  if (response.status === 404) return { status: 404, text: null };
  if (!response.ok) return { status: response.status, text: null, error: `HTTP ${response.status} ${response.statusText}` };
  return { status: response.status, text: await response.text() };
}

// Reads deck.json and returns the state change it implies; refresh() commits it with the slides.
async function loadDeck() {
  let result;
  try {
    result = await fetchText(DECK_URL);
  } catch (error) {
    result = { status: 0, text: null, error: String(error?.message || error) };
  }
  if (result.status === 404) {
    if (state.deckStatus === "missing") return null;
    return { deckStatus: "missing", deck: null, deckText: null, deckError: "", deckIssues: [issue("error", "deck-missing", "project/deck.json was not found")] };
  }
  if (result.text == null) {
    if (state.deckStatus === "invalid" && state.deckError === result.error) return null;
    return { deckStatus: "invalid", deckText: null, deckError: result.error, deckIssues: [issue("error", "deck-unreadable", `project/deck.json: ${result.error}`)] };
  }
  if (result.text === state.deckText && state.deckStatus !== "missing") return null;
  let raw;
  try {
    raw = JSON.parse(result.text);
  } catch (error) {
    return { deckStatus: "invalid", deck: null, deckText: result.text, deckError: String(error.message || error), deckIssues: [issue("error", "deck-json", `project/deck.json is not valid JSON: ${error.message}`)] };
  }
  const { deck, issues } = normalizeDeck(raw);
  return { deckStatus: "ok", deck, deckText: result.text, deckIssues: issues, deckError: "" };
}

async function loadSlide(id, force) {
  const current = state.slides.get(id);
  if (current && !force && (current.status === "ok" || current.status === "malformed")) return false;
  let result;
  try {
    result = await fetchText(`${DATA_ROOT}slides/${id}.html`);
  } catch (error) {
    result = { status: 0, text: null, error: String(error?.message || error) };
  }
  if (result.text == null) {
    const status = result.status === 404 ? "missing" : "error";
    if (current && current.status === status) return false;
    state.slides.set(id, {
      id, status, text: null, title: id, notes: "",
      issues: [status === "missing"
        ? issue("error", "slide-missing", `project/slides/${id}.html was not found`)
        : issue("error", "slide-unreadable", `project/slides/${id}.html: ${result.error}`)],
      error: result.error || "",
    });
    return true;
  }
  const edit = pendingEdits.get(id);
  if (edit) {
    if (result.text === edit.latest) pendingEdits.delete(id);
    else if ((result.text === edit.base || edit.posted.has(result.text)) && edit.stale++ < PENDING_EDIT_REFRESHES) return false;
    else pendingEdits.delete(id);
  }
  if (current && current.text === result.text) return false;
  state.slides.set(id, { id, text: result.text, ...parseSlide(id, result.text) });
  return true;
}

async function loadSlides(ids, force) {
  const changed = new Set();
  const queue = [...ids];
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift();
      if (await loadSlide(id, force)) changed.add(id);
    }
  };
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, queue.length) }, worker));
  return changed;
}

function incomplete() {
  if (state.deckStatus !== "ok") return true;
  return state.deck.order.some((id) => {
    const status = state.slides.get(id)?.status;
    return !status || status === "missing" || status === "error";
  });
}

let refreshing = null;
let queuedRefresh = null;

// One refresh at a time; a request during a refresh runs once after it, forced if any request was.
async function refresh(force) {
  if (refreshing) {
    queuedRefresh = { force: Boolean(queuedRefresh?.force || force) };
    return refreshing;
  }
  refreshing = (async () => {
    const previousIds = state.deck ? [...state.deck.order] : [];
    const deckPatch = await loadDeck();
    const next = { ...state, ...deckPatch };
    const changedSlides = next.deckStatus === "ok" ? await loadSlides(next.deck.order, force) : new Set();
    // Commit after every fetch, so navigation during the refresh is what the viewer keeps.
    const shownId = currentId();
    const deckChanged = Boolean(deckPatch);
    if (deckPatch) Object.assign(state, deckPatch);
    if (state.deckStatus === "ok") {
      for (const id of state.slides.keys()) if (!state.deck.order.includes(id)) state.slides.delete(id);
      for (const id of pendingEdits.keys()) if (!state.deck.order.includes(id)) pendingEdits.delete(id);
    }
    const orderChanged = previousIds.join("\n") !== (state.deck?.order || []).join("\n");
    if (deckChanged || orderChanged || changedSlides.size) onDataChanged({ deckChanged, orderChanged, changedSlides, shownId });
    return deckChanged || orderChanged || changedSlides.size > 0;
  })();
  try {
    return await refreshing;
  } finally {
    refreshing = null;
    if (queuedRefresh) {
      const { force: again } = queuedRefresh;
      queuedRefresh = null;
      refresh(again);
    }
  }
}

let pollTimer = null;
let pollDelay = POLL_MIN_MS;
let deployEventsLive = false;

function schedulePoll(changed) {
  clearTimeout(pollTimer);
  pollTimer = null;
  if (!incomplete()) {
    pollDelay = POLL_MIN_MS;
    return;
  }
  // With deploy events subscribed, polling is only a safety net for lost events.
  if (deployEventsLive) pollDelay = POLL_MAX_MS;
  else pollDelay = changed ? POLL_MIN_MS : Math.min(Math.round(pollDelay * 1.5), POLL_MAX_MS);
  pollTimer = setTimeout(async () => {
    await reloadIfRepinned();
    // Each poll fetches deck.json and the missing slides; loaded slides are revalidated at most every
    // POLL_MAX_MS, since viewers without deploy events see edits only this way.
    const revalidate = Date.now() - lastRevalidated >= POLL_MAX_MS;
    if (revalidate) lastRevalidated = Date.now();
    let changed = await refresh(revalidate);
    // Polling stops once the deck is complete, so the last poll revalidates the loaded slides too.
    if (!revalidate && !incomplete()) changed = (await refresh(true)) || changed;
    schedulePoll(changed);
  }, pollDelay);
}
let lastRevalidated = Date.now();

// Without deploy events a repin is visible only in the viewer files' ETag, "<version>-<sha256>".
async function reloadIfRepinned() {
  const response = await fetch("/_type/viewer.js", { method: "HEAD", cache: "no-store" }).catch(() => null);
  const version = /^(?:W\/)?"(.+)-[0-9a-f]{64}"$/.exec(response?.headers.get("ETag") || "")?.[1];
  if (version && version !== TYPE_VERSION) reloadForType(`${TYPE_NAME}@${version}`);
}

// Reload once per announced type version, so a package whose TYPE_VERSION disagrees with its
// type.json cannot reload forever.
function reloadForType(siteType) {
  const key = `slides-reload:${siteType}`;
  try {
    if (sessionStorage.getItem(key)) {
      console.warn(`[slides] site pins ${siteType} but this viewer is ${TYPE_ID}; not reloading again`);
      return;
    }
    sessionStorage.setItem(key, "1");
  } catch (error) {
    showReloadNotice(error);
    return;
  }
  location.reload();
}

// Without the once-per-version guard an automatic reload could repeat, so the visitor reloads instead.
function showReloadNotice(error) {
  if (document.querySelector(".update-banner")) return;
  console.warn(`[slides] cannot record the reload guard (${error?.message || error}); asking for a manual reload`);
  document.body.append(h("div", { class: "update-banner", role: "status" },
    h("span", { text: t("updated") }),
    h("button", { type: "button", class: "text-btn", onclick: () => location.reload() }, t("reload")),
  ));
}

function connectDeployEvents() {
  const host = location.hostname;
  if (host === "localhost" || /^[\d.]+$/.test(host) || host.includes(":") || host.split(".").length < 2) return;
  let attempts = 0;
  let everOpened = false;
  let stableTimer = null;
  const connect = () => {
    let socket;
    try {
      socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/ws`);
    } catch {
      return;
    }
    let opened = false;
    socket.addEventListener("open", () => {
      opened = true;
      everOpened = true;
      // The backoff resets only for a socket that stays up; an ingress that drops idle sockets at once
      // would otherwise cause a reconnect and a full refetch every 2 s.
      stableTimer = setTimeout(() => { attempts = 0; }, 30000);
      socket.send(JSON.stringify({ type: "subscribe", collection: "_spot_deploys" }));
    });
    socket.addEventListener("message", async (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === "subscribed" && message.collection === "_spot_deploys") {
        // Events sent while the socket was down are lost, so catch up once per (re)subscription,
        // including a repin that would otherwise leave this page on the old viewer.
        deployEventsLive = true;
        await reloadIfRepinned();
        schedulePoll(await refresh(true));
        return;
      }
      if (message.type !== "deploy" || message.collection !== "_spot_deploys") return;
      if (message.site_type && message.site_type !== TYPE_ID) {
        reloadForType(message.site_type);
        return;
      }
      schedulePoll(await refresh(true));
    });
    socket.addEventListener("close", () => {
      clearTimeout(stableTimer);
      deployEventsLive = false;
      // Anonymous visitors are refused, and polling covers them, so a socket that never opened gives up
      // after a few attempts. Once it has opened, the visitor is identified: keep retrying through a
      // Spot restart, since a complete deck does not poll and would otherwise stay stale.
      attempts += 1;
      if (!opened && !everOpened && attempts >= 3) return;
      setTimeout(connect, Math.min(1000 * 2 ** attempts, 30000));
    });
  };
  connect();
}

function activeTheme() {
  return themes.get(state.deck?.theme.preset ?? defaultThemeId) ?? null;
}

// Theme fonts fall back to the package's own families, which cover the scripts a theme font may lack.
const THEME_FONT_FALLBACK = {
  display: '"Inter Variable", var(--font-fallback)',
  body: '"Inter Variable", var(--font-fallback)',
  mono: '"JetBrains Mono Variable", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
};

// The preset's colors and fonts apply first; deck.json colors and fonts override them one by one.
function applyTheme() {
  const root = document.documentElement;
  const theme = state.deck?.theme;
  const preset = activeTheme();
  activeThemeId = preset?.id ?? null;
  if (activeThemeId) root.dataset.preset = activeThemeId;
  else delete root.dataset.preset;
  const sheet = themeSheets.get(activeThemeId);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets.filter((item) => ![...themeSheets.values()].includes(item)), ...(sheet ? [sheet] : [])];
  for (const scheme of ["light", "dark"]) {
    for (const name of TOKENS) {
      const property = `--${scheme[0]}-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
      const value = theme?.[scheme]?.[name] || preset?.[scheme]?.[name];
      if (value) root.style.setProperty(property, value);
      else root.style.removeProperty(property);
    }
  }
  for (const role of FONT_ROLES) {
    const font = theme?.fonts?.[role] || preset?.fonts?.[role];
    if (!font) {
      root.style.removeProperty(`--font-${role}`);
      continue;
    }
    const family = `"${font.family.replace(/["\\\n\r]/g, "")}"`;
    const fallback = font.fromType ? THEME_FONT_FALLBACK[role] : role === "mono" ? 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' : 'var(--font-fallback)';
    root.style.setProperty(`--font-${role}`, `${family}, ${fallback}`);
    if (font.href && !document.querySelector(`link[data-font-href="${CSS.escape(font.href)}"]`)) {
      const link = h("link", { rel: "stylesheet", href: font.href, "data-font-href": font.href });
      fontStylesheetLoads.push(new Promise((resolve) => {
        link.addEventListener("load", resolve, { once: true });
        link.addEventListener("error", resolve, { once: true });
      }));
      document.head.append(link);
    }
    for (const face of font.faces) {
      const key = `${font.family}|${face.src}|${face.weight}|${face.style}|${face.unicodeRange}`;
      if (loadedFaces.has(key)) continue;
      loadedFaces.add(key);
      const descriptors = { weight: face.weight, style: face.style, display: "swap", ...(face.unicodeRange ? { unicodeRange: face.unicodeRange } : {}) };
      const fontFace = new FontFace(font.family, `url("${face.src.replace(/"/g, "%22")}")`, descriptors);
      document.fonts.add(fontFace);
      fontFace.load().catch(() => {});
    }
  }
}
const loadedFaces = new Set();
const fontStylesheetLoads = [];

function initialScheme() {
  const forced = params.get("theme");
  if (forced === "light" || forced === "dark") return forced;
  try {
    const stored = localStorage.getItem("slides-scheme");
    if (stored === "light" || stored === "dark") return stored;
  } catch {}
  return null;
}
const userScheme = initialScheme();
// Once the visitor, the other window or the host picks a scheme, a deck update no longer changes it.
let schemeChosen = Boolean(userScheme);

function setScheme(scheme, { persist, broadcast, chosen } = {}) {
  state.scheme = scheme;
  document.documentElement.dataset.scheme = scheme;
  if (chosen) schemeChosen = true;
  if (persist) {
    try { localStorage.setItem("slides-scheme", scheme); } catch {}
  }
  if (broadcast) sync.post({ kind: "scheme", scheme });
  for (const fn of schemeListeners) fn();
  reportOutline();
}
const schemeListeners = [];

function sectionAt(index) {
  let found = null;
  for (const section of state.deck?.sections || []) if (section.start <= index) found = section;
  return found;
}

// A still (thumb) frame shows every step; a live frame shows the steps up to `step`.
function buildFrame(index, { thumb = false, step = 0 } = {}) {
  const id = state.deck.order[index];
  const slide = state.slides.get(id);
  const frame = h("div", { class: "frame", lang: state.deck.lang || null, "data-preset": activeThemeId });
  if (!slide || slide.status === "missing" || slide.status === "error" || !slide.fragment) {
    frame.classList.add("is-placeholder");
    const failed = slide?.status === "error";
    frame.append(h("section", null,
      h("div", { class: "placeholder-id", text: `${String(index + 1).padStart(2, "0")} · ${id}` }),
      h("div", { class: "placeholder-title", text: failed ? t("slideError") : t("pendingTitle") }),
      failed ? h("div", { class: "placeholder-body", text: slide.error }) : h("div", { class: "placeholder-body", text: t("pendingBody") }),
      failed ? null : h("div", { class: "placeholder-lines" }, h("i"), h("i"), h("i")),
    ));
    return { frame, sheets: [], still: thumb };
  }
  frame.append(slide.fragment.cloneNode(true));
  if (slide.layout) frame.dataset.layout = slide.layout;
  if (slide.theme) frame.dataset.theme = slide.theme;
  const footer = slide.footer === "on" || (slide.footer !== "off" && !NO_FOOTER_LAYOUTS.has(slide.layout));
  if (footer) {
    const section = sectionAt(index);
    const label = [state.deck.title, section?.title].filter(Boolean).join("  ·  ");
    frame.append(h("footer", { class: "frame-footer", "aria-hidden": "true" },
      h("span", { class: "frame-footer-title", text: label }),
      h("span", { class: "frame-footer-num" }, String(index + 1).padStart(2, "0"), h("span", { text: ` / ${String(state.deck.order.length).padStart(2, "0")}` })),
    ));
  }
  if (thumb) {
    // An inline !important declaration outranks the still sheet, so still frames override it inline.
    for (const el of frame.querySelectorAll("[style]")) {
      if (!/animation|transition/i.test(el.getAttribute("style"))) continue;
      el.style.setProperty("animation", "none", "important");
      el.style.setProperty("transition", "none", "important");
    }
    for (const img of frame.querySelectorAll("img[loading]")) img.removeAttribute("loading");
    for (const media of frame.querySelectorAll("video, audio")) {
      media.removeAttribute("autoplay");
      media.muted = true;
      media.preload = "metadata";
    }
    // Thumbnails, print and check keep the iframe and its sizing, but load nothing into it. The
    // PowerPoint export links the app's poster to the address kept in data-app-src.
    for (const iframe of frame.querySelectorAll("iframe")) {
      if (iframe.hasAttribute("src")) iframe.setAttribute("data-app-src", iframe.getAttribute("src"));
      iframe.removeAttribute("src");
      iframe.classList.add("embed-off");
      const poster = iframe.getAttribute("data-poster");
      if (poster) iframe.style.backgroundImage = `url("${poster.replace(/["\n]/g, encodeURIComponent)}")`;
    }
  } else {
    applySteps(frame, step);
    for (const iframe of frame.querySelectorAll("iframe")) handBackEscape(iframe);
  }
  return { frame, sheets: slide.sheets, still: thumb };
}

// Thumbnail, print and check frames show the end state. The rules sit in the first layer of the
// first sheet, and important declarations in an earlier layer beat every later and unlayered one.
const STILL_SHEET = new CSSStyleSheet();
STILL_SHEET.replaceSync("@layer slides-still { *, *::before, *::after { animation: none !important; transition: none !important; pointer-events: none !important; } }");

// A focused app keeps its keys. In a same-origin app, Escape returns focus to the deck unless the app
// handles Escape itself (preventDefault); a cross-origin frame cannot be reached, so a click outside it does.
function handBackEscape(iframe) {
  iframe.addEventListener("load", () => {
    let win;
    try {
      win = iframe.contentWindow;
      void win.document;
    } catch {
      return; // cross-origin: the browser does not let the deck listen to the frame's keys
    }
    win.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      iframe.blur();
      window.focus();
    });
  });
}

function mountFrame(host, { frame, sheets, still }) {
  const root = host.shadowRoot || host.attachShadow({ mode: "open" });
  // The theme stylesheet sits between the built-in styles and the slide's own.
  const theme = themeSheets.has(activeThemeId) ? [themeSheets.get(activeThemeId)] : [];
  root.adoptedStyleSheets = [...(still ? [STILL_SHEET] : []), slideSheet, ...theme, ...sheets];
  // Still frames are pictures: clicks reach the overview button and nothing inside takes focus.
  frame.inert = Boolean(still);
  root.replaceChildren(frame);
}

// A .slot scales its 1920x1080 host to the slot's box.
const slotObserver = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const { width, height } = entry.contentRect;
    if (!width || !height) continue;
    entry.target.style.setProperty("--scale", String(Math.min(width / W, height / H)));
  }
});

function releaseSlots(container) {
  for (const slot of container.querySelectorAll(".slot")) slotObserver.unobserve(slot);
}

function makeSlot(className) {
  const host = h("div", { class: "slide-host" });
  const slot = h("div", { class: `slot ${className || ""}` }, host);
  slotObserver.observe(slot);
  return { slot, host };
}

function renderInto(slot, index, options) {
  if (!state.deck || index < 0 || index >= state.deck.order.length) return;
  mountFrame(slot.host, buildFrame(index, options));
}

// A step change updates the mounted frame in place, so the reveal can transition and apps keep running.
function showStep(host) {
  const frame = host.shadowRoot?.querySelector(".frame");
  return frame ? applySteps(frame, state.step) : [];
}

function total() {
  return state.deck ? state.deck.order.length : 0;
}

function currentId() {
  return state.deck?.order[state.index] ?? null;
}

function stepCount(index = state.index) {
  return state.slides.get(state.deck?.order[index])?.steps || 0;
}

function syncHash() {
  const hash = `#${encodeURIComponent(currentId())}${state.step ? `.${state.step}` : ""}`;
  if (location.hash !== hash) history.replaceState(null, "", `${location.pathname}${location.search}${hash}`);
}

// Jumps land on step 0; `step` is clamped to the slide's steps.
function go(index, { from = "local", step = 0 } = {}) {
  if (!total()) return;
  const next = Math.max(0, Math.min(total() - 1, index));
  const moved = next !== state.index;
  if (moved && editing.on) setEditing(false);
  const nextStep = editing.on ? stepCount(next) : Math.max(0, Math.min(stepCount(next), step));
  const stepped = nextStep === state.step ? false : nextStep > state.step ? "forward" : "back";
  state.index = next;
  state.step = nextStep;
  syncHash();
  reportSlide();
  view.render?.({ moved, stepped, full: false });
  if (from === "local") sync.post({ kind: "goto", id: currentId(), step: state.step });
}

// Forward reveals the next step before it leaves the slide; back hides the last step, and coming back
// to the previous slide shows it with every step.
function goNext() {
  if (state.step < stepCount()) go(state.index, { step: state.step + 1 });
  else if (state.index < total() - 1) go(state.index + 1);
}

function goPrevious() {
  if (state.step > 0 && !editing.on) go(state.index, { step: state.step - 1 });
  else if (state.index > 0) go(state.index - 1, { step: stepCount(state.index - 1) });
}

function atStart() {
  return state.index === 0 && state.step === 0;
}

function atEnd() {
  return state.index === total() - 1 && state.step >= stepCount();
}

function goToId(id, options) {
  const index = state.deck?.order.indexOf(id) ?? -1;
  if (index >= 0) go(index, options);
}

window.addEventListener("hashchange", () => {
  const { id, step } = parseHash();
  if (id && (id !== currentId() || step !== state.step)) goToId(id, { step });
});

let digitBuffer = "";
let digitTimer = null;

function onKeyDown(event) {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === "Escape" && editing.on) {
    event.preventDefault();
    setEditing(false);
    return;
  }
  const target = event.composedPath()[0];
  if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
  if (document.querySelector("dialog[open]")) return;
  const key = event.key;
  const onControl = event.composedPath().some((node) => node instanceof Element && node.matches("button, a[href], summary, [role='button']"));
  if ((key === " " || key === "Enter") && onControl) return;
  let handled = true;
  if (/^[0-9]$/.test(key)) {
    digitBuffer += key;
    clearTimeout(digitTimer);
    digitTimer = setTimeout(() => { digitBuffer = ""; }, 1500);
  } else if (key === "Enter" && digitBuffer) {
    go(Number(digitBuffer) - 1);
    digitBuffer = "";
  } else if (["ArrowRight", "ArrowDown", "PageDown", "n", "j", "l"].includes(key) || (key === " " && !event.shiftKey)) {
    goNext();
  } else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace", "h", "k"].includes(key) || (key === " " && event.shiftKey)) {
    goPrevious();
  } else if (key === "Home") {
    go(0);
  } else if (key === "End") {
    go(total() - 1, { step: stepCount(total() - 1) });
  } else if ((key === "o" || key === "g") && !EMBED) {
    openOverview();
  } else if (key === "f" && !EMBED) {
    toggleFullscreen();
  } else if (key === "s" || key === "p") {
    if (!PRESENTER && !EMBED) openPresenter();
  } else if (key === "t") {
    toggleScheme();
  } else if (key === "b" || key === ".") {
    setBlackout(!state.blackout, true);
  } else if (key === "?" && !EMBED) {
    openHelp();
  } else {
    handled = false;
  }
  if (handled) event.preventDefault();
}

function toggleScheme() {
  setScheme(state.scheme === "dark" ? "light" : "dark", { persist: true, broadcast: true, chosen: true });
}

function setBlackout(on, broadcast) {
  state.blackout = on;
  app.classList.toggle("is-blackout", on);
  if (broadcast) sync.post({ kind: "blackout", on });
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

function openPresenter() {
  const url = `${location.pathname}?presenter=1${location.hash}`;
  const win = window.open(url, `slides-presenter-${location.host}`, "popup,width=1280,height=800");
  if (win) sync.addPeer(win);
  return win;
}

// Presenter and audience windows of this deck in one browser follow each other. The BroadcastChannel
// reaches the windows of this origin in one storage partition. An embedded viewer sits in its host's
// partition, so messages also go straight to the windows this one knows: the presenter window it
// opened, its opener and the opener's frames (a presenter window that a host page opened), and every
// window of this origin that messaged it. A message can arrive both ways and is handled once.
const sync = (() => {
  const role = PRESENTER ? "presenter" : "audience";
  const channel = "BroadcastChannel" in window ? new BroadcastChannel(`slides:${location.host}`) : null;
  const sender = Math.random().toString(36).slice(2);
  const peers = new Set();
  let hostPort = null;
  const seen = new Set();
  let sent = 0;
  // Reading a window's location throws across origins, the only test of a WindowProxy's origin.
  const sameOrigin = (win) => {
    try {
      return win.location.origin === location.origin;
    } catch {
      return false;
    }
  };
  const targets = () => {
    for (const peer of peers) if (peer.closed) peers.delete(peer);
    const list = [...peers];
    const opener = window.opener;
    if (opener && !opener.closed) {
      list.push(opener);
      for (let i = 0; i < opener.length; i += 1) list.push(opener[i]);
    }
    return list.filter((win) => win !== window && !win.closed && sameOrigin(win));
  };
  const post = (message) => {
    sent += 1;
    const data = { ...message, role, sender, seq: `${sender}.${sent}` };
    channel?.postMessage(data);
    hostPort?.postMessage(data);
    for (const peer of targets()) peer.postMessage({ slidesSync: data }, location.origin);
  };
  const receive = (data, source) => {
    if (!data || data.sender === sender || data.role === role) return;
    if (data.seq) {
      if (seen.has(data.seq)) return;
      seen.add(data.seq);
      if (seen.size > 200) seen.delete(seen.values().next().value);
    }
    if (source) peers.add(source);
    if (data.kind === "goto") {
      const step = Number.isInteger(data.step) ? data.step : 0;
      if (state.deck) goToId(data.id, { from: "remote", step });
      else Object.assign(state, { pendingId: data.id, pendingStep: step });
    } else if (data.kind === "hello" && currentId()) {
      post({ kind: "goto", id: currentId(), step: state.step });
      post({ kind: "scheme", scheme: state.scheme });
    } else if (data.kind === "scheme" && (data.scheme === "light" || data.scheme === "dark")) {
      setScheme(data.scheme, { chosen: true });
    } else if (data.kind === "blackout" && !PRESENTER) {
      setBlackout(Boolean(data.on));
    }
  };
  channel?.addEventListener("message", ({ data }) => receive(data));
  window.addEventListener("message", (event) => {
    if (event.origin === location.origin && event.source && event.data?.slidesSync) receive(event.data.slidesSync, event.source);
  });
  return {
    post,
    addPeer: (win) => peers.add(win),
    connectHostPort(port) {
      hostPort?.close();
      hostPort = port;
      port.onmessage = ({ data }) => receive(data);
      if (PRESENTER) post({ kind: "hello" });
    },
  };
})();

let overviewDialog = null;

function openOverview() {
  if (!state.deck || !total() || overviewDialog) return;
  const items = [];
  const body = h("div", { class: "overview-body" });
  const title = h("h2");
  const dialog = h("dialog", { class: "overview", "aria-label": t("overview") },
    h("div", { class: "overview-head" },
      title,
      iconButton("print", t("print"), () => { dialog.close(); setTimeout(() => window.print(), 50); }),
      iconButton("close", t("close"), () => dialog.close()),
    ),
    body,
  );

  // Rebuilds the grid in place, so a refresh while the overview is open keeps it open.
  const fill = () => {
    const focusedIndex = Number(document.activeElement?.closest?.(".ov-item")?.dataset.index ?? -1);
    const scrollTop = dialog.scrollTop;
    title.textContent = state.deck.title || t("slides");
    items.length = 0;
    releaseSlots(body);
    body.replaceChildren();
    const groups = [];
    let group = { section: null, items: [] };
    state.deck.order.forEach((id, index) => {
      const section = state.deck.sections.find((item) => item.start === index);
      if (section) {
        if (group.items.length || group.section) groups.push(group);
        group = { section, items: [] };
      }
      group.items.push(index);
    });
    groups.push(group);
    groups.forEach((entry, groupIndex) => {
      if (entry.section) {
        const number = state.deck.sections.indexOf(entry.section) + 1;
        body.append(h("h3", { class: "ov-section-title" }, h("span", { text: String(number).padStart(2, "0") }), entry.section.title));
      }
      const grid = h("div", { class: "ov-grid", role: "list" });
      for (const index of entry.items) {
        const slot = makeSlot();
        renderInto(slot, index, { thumb: true });
        const slideTitle = state.slides.get(state.deck.order[index])?.title || state.deck.order[index];
        const button = h("button", {
          type: "button",
          class: "ov-item",
          role: "listitem",
          "aria-current": index === state.index ? "true" : null,
          "aria-label": `${t("slideOf", { n: index + 1, total: total() })}: ${slideTitle}`,
          onclick: () => { dialog.close(); go(index); },
        }, slot.slot, h("span", { class: "ov-caption" }, h("b", { text: String(index + 1).padStart(2, "0") }), h("span", { text: slideTitle })));
        button.dataset.index = String(index);
        items.push(button);
        grid.append(button);
      }
      if (groupIndex === 0 && !entry.section) grid.style.marginTop = "28px";
      body.append(grid);
    });
    dialog.scrollTop = scrollTop;
    items[focusedIndex]?.focus({ preventScroll: true });
  };

  dialog.addEventListener("keydown", (event) => {
    const focused = document.activeElement?.closest?.(".ov-item");
    if (!focused || !["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    const at = items.indexOf(focused);
    const rect = focused.getBoundingClientRect();
    let target = null;
    if (event.key === "ArrowRight") target = items[at + 1];
    else if (event.key === "ArrowLeft") target = items[at - 1];
    else {
      const down = event.key === "ArrowDown";
      const candidates = items.filter((item) => {
        const r = item.getBoundingClientRect();
        return down ? r.top > rect.bottom - 1 : r.bottom < rect.top + 1;
      });
      const row = down ? candidates.slice(0) : candidates.reverse();
      const rowTop = row[0]?.getBoundingClientRect().top;
      target = row.filter((item) => item.getBoundingClientRect().top === rowTop)
        .sort((a, b) => Math.abs(a.getBoundingClientRect().left - rect.left) - Math.abs(b.getBoundingClientRect().left - rect.left))[0];
    }
    target?.focus();
    target?.scrollIntoView({ block: "nearest" });
  });
  dialog.addEventListener("close", () => {
    releaseSlots(dialog);
    dialog.remove();
    if (overviewDialog === dialog) overviewDialog = null;
  });
  overviewDialog = dialog;
  overviewDialog.refresh = fill;
  fill();
  document.body.append(dialog);
  dialog.showModal();
  const current = items[state.index];
  current?.focus();
  current?.scrollIntoView({ block: "center" });
}

function openHelp() {
  const rows = [
    [["→", "Space"], t("next")],
    [["←", "⇧ Space"], t("previous")],
    [["Home", "End"], t("firstLast")],
    [["1…9", "Enter"], t("goTo")],
    [["O"], t("overview")],
    [["S"], t("presenter")],
    [["F"], t("fullscreen")],
    [["T"], `${t("toDark")} / ${t("toLight")}`],
    [["B"], t("blackout")],
    [["?"], t("shortcuts")],
  ];
  const dialog = h("dialog", { class: "help", "aria-label": t("shortcuts") },
    h("div", { class: "help-head" }, h("h2", { text: t("shortcuts") }), iconButton("close", t("close"), () => dialog.close())),
    h("dl", null, rows.map(([keys, label]) => [h("dt", null, keys.map((key) => h("kbd", { text: key }))), h("dd", { text: label })])),
  );
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

let view = {};
const live = h("div", { class: "sr-only", "aria-live": "polite" });

function showNotice(kind) {
  const notice = h("div", { class: "notice" });
  let card;
  if (kind === "loading") card = h("div", { class: "notice-card" }, h("div", { class: "spinner" }), h("p", { text: t("loading") }));
  else if (kind === "empty") card = h("div", { class: "notice-card" }, h("div", { class: "notice-mark" }), h("h1", { text: t("emptyTitle") }), h("p", { text: t("emptyBody") }));
  else card = h("div", { class: "notice-card" }, h("div", { class: "notice-mark" }), h("h1", { text: t("deckError") }), h("pre", { text: state.deckError || state.deckIssues.map((item) => item.message).join("\n") }));
  notice.append(card);
  return notice;
}

// Embed mode's slide strip: a still of every slide with its number, grouped by section.
function slideStrip() {
  const list = h("ol");
  const nav = h("nav", { class: "strip", "aria-label": t("slides") }, list);
  let items = [];
  const paint = (index) => {
    const item = items[index];
    if (!item) return;
    renderInto(item.slot, index, { thumb: true });
    const title = state.slides.get(state.deck.order[index])?.title || state.deck.order[index];
    item.button.setAttribute("aria-label", `${t("slideOf", { n: index + 1, total: total() })}: ${title}`);
  };
  const build = () => {
    releaseSlots(list);
    list.replaceChildren();
    items = [];
    if (state.deckStatus !== "ok") return;
    state.deck.order.forEach((id, index) => {
      const section = state.deck.sections.find((entry) => entry.start === index);
      if (section) list.append(h("li", { class: "strip-section", "aria-hidden": "true", text: section.title }));
      const slot = makeSlot();
      const button = h("button", { type: "button", onclick: () => go(index) }, slot.slot);
      items.push({ slot, button });
      list.append(h("li", { class: "strip-item" }, h("span", { class: "strip-num", "aria-hidden": "true", text: String(index + 1) }), button));
      paint(index);
    });
  };
  // Scrolls only the strip: scrollIntoView could also scroll the host page.
  const mark = (reveal) => {
    items.forEach((item, index) => {
      if (index === state.index) item.button.setAttribute("aria-current", "true");
      else item.button.removeAttribute("aria-current");
    });
    const button = items[state.index]?.button;
    if (!reveal || !button) return;
    const box = nav.getBoundingClientRect();
    const rect = button.getBoundingClientRect();
    if (rect.top < box.top) nav.scrollTop -= box.top - rect.top + 12;
    else if (rect.bottom > box.bottom) nav.scrollTop += rect.bottom - box.bottom + 12;
    if (rect.left < box.left) nav.scrollLeft -= box.left - rect.left + 12;
    else if (rect.right > box.right) nav.scrollLeft += rect.right - box.right + 12;
  };
  return {
    nav,
    dataChanged({ deckChanged, orderChanged, changedSlides }) {
      if (deckChanged || orderChanged) build();
      else for (const id of changedSlides) paint(state.deck.order.indexOf(id));
      mark(true);
    },
    mark,
  };
}

function audienceView() {
  const { slot, host } = makeSlot("stage");
  slot.setAttribute("role", "region");
  slot.setAttribute("aria-roledescription", "slide");
  const progress = h("div", { class: "progress" }, h("i"));
  const counter = h("div", { class: "counter", "aria-hidden": "true" });
  const prev = iconButton("prev", t("previous"), goPrevious);
  const next = iconButton("next", t("next"), goNext);
  const themeButton = iconButton("moon", t("toDark"), toggleScheme, "wide-only");
  const fullButton = iconButton("expand", t("fullscreen"), toggleFullscreen);
  const toolbar = h("div", { class: "toolbar", role: "toolbar", "aria-label": t("slides") },
    prev, counter, next, h("span", { class: "sep" }),
    iconButton("grid", t("overview"), openOverview),
    iconButton("presenter", t("presenter"), openPresenter, "wide-only"),
    themeButton, fullButton,
    iconButton("download", t("exportPptx"), downloadPptx, "wide-only export-btn"),
    iconButton("help", t("shortcuts"), openHelp, "wide-only"),
  );
  // Embedded, the host page draws the controls; the viewer keeps the stage and adds the strip.
  const strip = EMBED && !THUMBNAIL ? slideStrip() : null;
  let notice = null;

  const updateChrome = () => {
    const isDark = state.scheme === "dark";
    themeButton.replaceChildren(icon(isDark ? "sun" : "moon"));
    themeButton.setAttribute("aria-label", isDark ? t("toLight") : t("toDark"));
    themeButton.title = themeButton.getAttribute("aria-label");
    const full = Boolean(document.fullscreenElement);
    fullButton.replaceChildren(icon(full ? "shrink" : "expand"));
    fullButton.setAttribute("aria-label", full ? t("exitFullscreen") : t("fullscreen"));
    fullButton.title = fullButton.getAttribute("aria-label");
  };
  schemeListeners.push(updateChrome);
  document.addEventListener("fullscreenchange", updateChrome);

  // Click: left third goes back, the rest forward. Interactive content in a slide keeps its click.
  let suppressClick = false;
  slot.addEventListener("click", (event) => {
    if (suppressClick) { suppressClick = false; return; }
    if (!total() || editing.on || String(getSelection()) !== "") return;
    if (editing.enabled && stageTextBlock(event, host)) return;
    const interactive = event.composedPath().some((node) => node instanceof Element && node.matches("a, button, input, select, textarea, label, summary, details, video, audio, iframe, [contenteditable], [tabindex]"));
    if (interactive) return;
    const rect = slot.getBoundingClientRect();
    if (event.clientX - rect.left < rect.width / 3) goPrevious();
    else goNext();
  });
  slot.addEventListener("dblclick", (event) => {
    if (!editing.enabled || editing.on || app.classList.contains("presenting")) return;
    const block = stageTextBlock(event, host);
    if (!block) return;
    const selection = stageSelection(host.shadowRoot);
    const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
    setEditing(true, host);
    block.focus({ preventScroll: true });
    if (range && block.contains(range.commonAncestorContainer)) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
    reportSelection();
  });
  document.addEventListener("pointerdown", (event) => {
    if (editing.on && !event.composedPath().some((node) => node instanceof Element && node.hasAttribute("data-slides-edit"))) setEditing(false);
  });
  let touch = null;
  slot.addEventListener("touchstart", (event) => {
    if (event.touches.length === 1) touch = { x: event.touches[0].clientX, y: event.touches[0].clientY };
  }, { passive: true });
  slot.addEventListener("touchend", (event) => {
    if (!touch || event.changedTouches.length !== 1 || editing.on) return;
    const dx = event.changedTouches[0].clientX - touch.x;
    const dy = event.changedTouches[0].clientY - touch.y;
    touch = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 400);
      if (dx < 0) goNext();
      else goPrevious();
    }
  });

  let idleTimer = null;
  const wake = () => {
    app.classList.remove("app-idle");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => app.classList.add("app-idle"), 2500);
  };
  for (const name of ["mousemove", "pointerdown", "keydown", "touchstart"]) window.addEventListener(name, wake, { passive: true });
  wake();

  app.replaceChildren(slot, progress, h("div", { class: "blackout" }), strip ? strip.nav : toolbar, live);
  app.classList.toggle("embed", EMBED || THUMBNAIL);
  app.classList.toggle("thumbnail", THUMBNAIL);
  updateChrome();

  return {
    dataChanged: strip?.dataChanged,
    render({ moved, stepped, full } = {}) {
      notice?.remove();
      notice = null;
      if (state.deckStatus !== "ok" || !total()) {
        host.shadowRoot?.replaceChildren();
        toolbar.hidden = true;
        progress.hidden = true;
        if (strip) strip.nav.hidden = true;
        const kind = state.deckStatus === "loading" ? "loading" : state.deckStatus === "invalid" ? "error" : "empty";
        notice = showNotice(kind);
        app.prepend(notice);
        document.title = state.deck?.title || t("slides");
        return;
      }
      toolbar.hidden = false;
      progress.hidden = false;
      if (strip) {
        strip.nav.hidden = false;
        if (moved) strip.mark(true);
      }
      if (moved || full !== false) {
        clearSlideSelection();
        renderInto({ slot, host }, state.index, { step: state.step });
        if (editing.on) makeEditable(host, state.index);
      }
      else if (stepped) {
        // Screen readers do not announce content that becomes visible, so a step says what it revealed.
        const revealed = revealedText(showStep(host));
        live.textContent = (stepped === "forward" && revealed) || t("stepOf", { n: state.step, total: stepCount() });
      }
      if (moved) {
        slot.classList.remove("entering");
        void slot.offsetWidth;
        slot.classList.add("entering");
      }
      const n = state.index + 1;
      counter.replaceChildren(h("b", { text: String(n) }), ` / ${total()}`);
      progress.firstChild.style.width = `${(n / total()) * 100}%`;
      prev.disabled = atStart();
      next.disabled = atEnd();
      const title = state.slides.get(currentId())?.title || currentId();
      slot.setAttribute("aria-label", `${t("slideOf", { n, total: total() })}: ${title}`);
      if (moved) live.textContent = `${t("slideOf", { n, total: total() })}: ${title}`;
      document.title = state.deck.title ? `${state.deck.title}` : t("slides");
    },
  };
}

function presenterView() {
  app.classList.add("presenter");
  const current = makeSlot();
  const nextSlot = makeSlot();
  const nextBox = h("div", { class: "pv-next" }, h("p", { class: "pv-label", text: t("nextUp") }), nextSlot.slot);
  const endBox = h("div", { class: "pv-end", text: t("end") });
  const notesText = h("div", { class: "pv-notes-text" });
  const counter = h("span", { class: "pv-counter" });
  const stepLabel = h("span", { class: "pv-step" });
  const timeEl = h("span", { class: "pv-time", "aria-label": t("elapsed"), role: "timer" });
  const clock = h("span", { class: "pv-clock" });
  const title = h("div", { class: "pv-title" });
  let started = Date.now();
  let pausedAt = null;
  const pauseButton = iconButton("pause", t("pause"), () => {
    if (pausedAt) { started += Date.now() - pausedAt; pausedAt = null; }
    else pausedAt = Date.now();
    tick();
  });
  const tick = () => {
    const elapsed = Math.floor(((pausedAt || Date.now()) - started) / 1000);
    const hours = Math.floor(elapsed / 3600);
    const mm = String(Math.floor((elapsed % 3600) / 60)).padStart(2, "0");
    const ss = String(elapsed % 60).padStart(2, "0");
    timeEl.textContent = hours ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
    timeEl.classList.toggle("paused", Boolean(pausedAt));
    pauseButton.replaceChildren(icon(pausedAt ? "play" : "pause"));
    pauseButton.setAttribute("aria-label", pausedAt ? t("resume") : t("pause"));
    pauseButton.title = pauseButton.getAttribute("aria-label");
    clock.textContent = new Date().toLocaleTimeString(UI_LANG, { hour: "2-digit", minute: "2-digit" });
  };
  setInterval(tick, 500);
  let notesSize = 22;
  try { notesSize = Number(localStorage.getItem("slides-notes-size")) || 22; } catch {}
  const setNotesSize = (size) => {
    notesSize = Math.max(14, Math.min(48, size));
    app.style.setProperty("--notes-size", `${notesSize}px`);
    try { localStorage.setItem("slides-notes-size", String(notesSize)); } catch {}
  };
  setNotesSize(notesSize);
  const themeButton = iconButton("moon", t("toDark"), toggleScheme);
  schemeListeners.push(() => {
    const isDark = state.scheme === "dark";
    themeButton.replaceChildren(icon(isDark ? "sun" : "moon"));
    themeButton.setAttribute("aria-label", isDark ? t("toLight") : t("toDark"));
    themeButton.title = themeButton.getAttribute("aria-label");
  });
  const prevButton = h("button", { type: "button", class: "text-btn", onclick: goPrevious }, icon("prev"), t("previous"));
  const nextButton = h("button", { type: "button", class: "text-btn", onclick: goNext }, t("next"), icon("next"));
  const side = h("div", { class: "pv-side" }, nextBox,
    h("div", { class: "pv-notes" },
      h("p", { class: "pv-label" }, h("span", { text: t("notes") }), h("span", { class: "pv-size" },
        h("button", { type: "button", class: "icon-btn", "aria-label": t("smaller"), title: t("smaller"), onclick: () => setNotesSize(notesSize - 2) }, "A−"),
        h("button", { type: "button", class: "icon-btn", "aria-label": t("larger"), title: t("larger"), onclick: () => setNotesSize(notesSize + 2) }, "A+"),
      )),
      notesText,
    ),
  );
  const main = h("div", { class: "pv-main" }, h("div", { class: "pv-current" }, current.slot), side);
  app.replaceChildren(
    h("header", { class: "pv-head" }, title,
      h("span", { class: "pv-timer" }, timeEl, pauseButton, iconButton("reset", t("reset"), () => { started = Date.now(); pausedAt = pausedAt ? started : null; tick(); })),
      clock, stepLabel, counter),
    main,
    h("footer", { class: "pv-foot" }, h("div", { class: "pv-nav" }, prevButton, nextButton),
      h("div", { class: "pv-nav" }, iconButton("grid", t("overview"), openOverview), themeButton, iconButton("help", t("shortcuts"), openHelp))),
    live,
  );
  tick();
  let notice = null;
  return {
    render({ moved, stepped, full } = {}) {
      notice?.remove();
      notice = null;
      if (state.deckStatus !== "ok" || !total()) {
        notice = showNotice(state.deckStatus === "loading" ? "loading" : state.deckStatus === "invalid" ? "error" : "empty");
        main.hidden = true;
        app.insertBefore(notice, main);
        return;
      }
      main.hidden = false;
      if (moved || full !== false) renderInto(current, state.index, { step: state.step });
      else if (stepped) showStep(current.host);
      const hasNext = state.index + 1 < total();
      nextBox.hidden = !hasNext;
      if (hasNext) renderInto(nextSlot, state.index + 1, { thumb: true });
      if (!hasNext && !endBox.isConnected) side.prepend(endBox);
      if (hasNext) endBox.remove();
      const slide = state.slides.get(currentId());
      notesText.textContent = slide?.notes || t("noNotes");
      notesText.classList.toggle("empty", !slide?.notes);
      notesText.scrollTop = 0;
      counter.textContent = `${state.index + 1} / ${total()}`;
      stepLabel.textContent = stepCount() ? t("stepOf", { n: state.step, total: stepCount() }) : "";
      stepLabel.hidden = !stepCount();
      title.textContent = state.deck.title || t("slides");
      document.title = `${t("presenter")} · ${state.deck.title || t("slides")}`;
      prevButton.disabled = atStart();
      nextButton.disabled = atEnd();
    },
  };
}

const printRoot = h("div", { id: "print-root" });

function buildPrint() {
  printRoot.replaceChildren();
  if (state.deckStatus !== "ok") return;
  state.deck.order.forEach((_, index) => {
    const host = h("div", { class: "slide-host" });
    mountFrame(host, buildFrame(index, { thumb: true }));
    printRoot.append(h("div", { class: "print-page" }, host));
  });
}

window.addEventListener("beforeprint", buildPrint);

function describe(node, root) {
  const parts = [];
  for (let el = node; el && el !== root; el = el.parentElement) {
    let part = el.localName;
    if (el.id) part += `#${el.id}`;
    else if (el.classList.length) part += `.${[...el.classList].filter((name) => !name.startsWith("check-")).join(".")}`;
    const parent = el.parentElement;
    if (parent && !el.id) {
      const same = [...parent.children].filter((child) => child.localName === el.localName);
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(el) + 1})`;
    }
    parts.unshift(part);
    if (el.localName === "section") break;
  }
  return parts.join(" > ");
}

function waitForMedia(frame) {
  const images = [...frame.querySelectorAll("img")];
  const pending = images.filter((img) => !img.complete).map((img) => new Promise((resolve) => {
    img.addEventListener("load", resolve, { once: true });
    img.addEventListener("error", resolve, { once: true });
  }));
  return Promise.race([Promise.all(pending), new Promise((resolve) => setTimeout(resolve, 8000))]);
}

const BLEED = ':is([data-layout="image"]) > section > :is(img, figure, video):first-child, :is([data-layout="split"]) > section > :is(img, figure, video, svg, .media):last-child';

function measureFrame(frame) {
  const issues = [];
  const marks = [];
  const section = frame.querySelector(":scope > section");
  if (!section) return { issues, marks };
  const frameRect = frame.getBoundingClientRect();
  const style = getComputedStyle(section);
  const safe = {
    left: frameRect.left + parseFloat(style.paddingLeft),
    top: frameRect.top + parseFloat(style.paddingTop),
    right: frameRect.right - parseFloat(style.paddingRight),
    bottom: frameRect.bottom - parseFloat(style.paddingBottom),
  };
  const layout = frame.dataset.layout;
  const all = [...section.querySelectorAll("*")];
  const worst = [];
  const bleedRoots = [...frame.querySelectorAll(BLEED)];
  const inBleed = (el) => layout === "blank" || bleedRoots.some((root) => root === el || root.contains(el));
  const over = (rect, box) => Math.max(box.left - rect.left, box.top - rect.top, rect.right - box.right, rect.bottom - box.bottom);

  // Text boxes extend above and below tight line boxes (headings), so text gets a vertical allowance.
  const check = (el, rect, slack = 0) => {
    if (!rect.width && !rect.height) return;
    const bound = inBleed(el) ? frameRect : safe;
    const box = { left: bound.left, right: bound.right, top: bound.top - slack, bottom: bound.bottom + slack };
    const amount = over(rect, box);
    if (amount > 2) worst.push({ el, amount, rect, box, bleed: bound === frameRect });
  };
  const clipped = (el, cs) => /(hidden|clip|auto|scroll)/.test(cs.overflowX + cs.overflowY) && !/^(img|video|canvas|svg|iframe)$/.test(el.localName)
    && (el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2);
  if (clipped(section, style)) {
    issues.push(issue("error", "clipped", `section clips its content by ${Math.max(section.scrollWidth - section.clientWidth, section.scrollHeight - section.clientHeight)}px`, { element: "section" }));
  }
  for (const el of all) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.position === "fixed" || el.localName === "style") continue;
    check(el, el.getBoundingClientRect());
    if (clipped(el, cs)) {
      issues.push(issue("error", "clipped", `${describe(el, frame)} clips its content by ${Math.max(el.scrollWidth - el.clientWidth, el.scrollHeight - el.clientHeight)}px`, { element: describe(el, frame) }));
      marks.push(all.indexOf(el));
    }
  }
  const walker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent.trim() || node.parentElement?.closest("style")) continue;
    if (getComputedStyle(node.parentElement).visibility === "hidden") continue;
    range.selectNodeContents(node);
    check(node.parentElement, range.getBoundingClientRect(), 0.3 * parseFloat(getComputedStyle(node.parentElement).fontSize));
  }
  // Report the outermost offenders only: a child of an overflowing element adds no information.
  worst.sort((a, b) => b.amount - a.amount);
  const reported = [];
  for (const entry of worst) {
    if (reported.some((other) => other.el.contains(entry.el) || entry.el.contains(other.el))) continue;
    reported.push(entry);
    if (reported.length >= 4) break;
  }
  for (const entry of reported) {
    const { rect, box } = entry;
    const sides = [];
    if (rect.bottom - box.bottom > 2) sides.push(`${Math.round(rect.bottom - box.bottom)}px below`);
    if (rect.right - box.right > 2) sides.push(`${Math.round(rect.right - box.right)}px right of`);
    if (box.top - rect.top > 2) sides.push(`${Math.round(box.top - rect.top)}px above`);
    if (box.left - rect.left > 2) sides.push(`${Math.round(box.left - rect.left)}px left of`);
    const area = entry.bleed ? "the slide" : "the safe area";
    issues.push(issue("error", "overflow", `${describe(entry.el, frame)} extends ${sides.join(", ")} ${area}`, {
      element: describe(entry.el, frame),
      overflow: { bottom: Math.round(Math.max(0, rect.bottom - box.bottom)), right: Math.round(Math.max(0, rect.right - box.right)), top: Math.round(Math.max(0, box.top - rect.top)), left: Math.round(Math.max(0, box.left - rect.left)) },
    }));
    marks.push(all.indexOf(entry.el));
  }
  for (const img of section.querySelectorAll("img")) {
    if (img.complete && img.naturalWidth === 0) issues.push(issue("error", "asset-missing", `Image ${img.getAttribute("src") || "(no src)"} did not load`, { src: img.getAttribute("src") }));
    else if (!img.complete) issues.push(issue("error", "asset-timeout", `Image ${img.getAttribute("src")} did not finish loading within 8 s`, { src: img.getAttribute("src") }));
  }
  return { issues, marks, safe: { top: parseFloat(style.paddingTop), right: parseFloat(style.paddingRight), bottom: parseFloat(style.paddingBottom), left: parseFloat(style.paddingLeft) } };
}

function measureDeck(hosts, results, order, slides) {
  order.forEach((id, index) => {
    const slide = slides[index];
    const parseIssues = slide?.issues || [];
    const measured = slide?.fragment ? measureFrame(hosts[index]) : { issues: [], marks: [] };
    const issues = [...parseIssues, ...measured.issues];
    let status = "ok";
    if (!slide || slide.status === "missing") status = "missing";
    else if (slide.status === "error") status = "unreadable";
    else if (slide.status === "malformed") status = "malformed";
    else if (measured.issues.some((item) => item.code === "overflow" || item.code === "clipped")) status = "overflow";
    else if (issues.some((item) => item.level === "error")) status = "error";
    else if (issues.length) status = "warning";
    results.push({ id, index: index + 1, file: `project/slides/${id}.html`, title: slide?.title || id, status, notes: Boolean(slide?.notes), steps: slide?.steps || 0, issues, marks: measured.marks, safe: measured.safe });
  });
}

let checkRun = 0;

async function runCheck() {
  const run = ++checkRun;
  document.documentElement.dataset.slidesCheck = "running";
  const results = [];
  if (state.deckStatus === "ok") {
    const measure = h("div", { class: "measure", "aria-hidden": "true" });
    document.body.append(measure);
    try {
      const order = [...state.deck.order];
      const slides = order.map((id) => state.slides.get(id));
      const hosts = order.map((_, index) => {
        const host = h("div", { class: "slide-host" });
        measure.append(host);
        const built = buildFrame(index, { thumb: true });
        mountFrame(host, built);
        return built.frame;
      });
      // Theme stylesheets first, then layout, so the fonts the slides use are requested before
      // fonts.ready is awaited.
      await Promise.race([Promise.all(fontStylesheetLoads), new Promise((resolve) => setTimeout(resolve, 8000))]);
      void measure.offsetHeight;
      await document.fonts.ready;
      await Promise.all(hosts.map(waitForMedia));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (run !== checkRun) return;
      measureDeck(hosts, results, order, slides);
    } finally {
      measure.remove();
    }
  }
  const all = [...typeIssues, ...state.deckIssues, ...results.flatMap((slide) => slide.issues)];
  const errors = all.filter((item) => item.level === "error").length;
  const warnings = all.filter((item) => item.level === "warning").length;
  const report = {
    type: TYPE_ID,
    ok: errors === 0,
    complete: !incomplete(),
    package: { issues: typeIssues },
    deck: { status: state.deckStatus === "ok" && state.deckIssues.some((item) => item.level === "error") ? "error" : state.deckStatus, title: state.deck?.title || "", preset: activeThemeId, slides: total(), sections: (state.deck?.sections || []).map((section) => ({ id: section.id, title: section.title, start: state.deck.order[section.start] })), issues: state.deckIssues },
    summary: {
      errors,
      warnings,
      missing: results.filter((slide) => slide.status === "missing").length,
      overflow: results.filter((slide) => slide.status === "overflow").length,
      malformed: results.filter((slide) => slide.status === "malformed").length,
    },
    slides: results.map(({ marks, safe, ...slide }) => slide),
  };
  window.slidesCheck = report;
  console.info(`[slides-check] ${JSON.stringify(report)}`);
  renderCheck(report, results);
  document.documentElement.dataset.slidesCheck = "done";
}

function renderCheck(report, results) {
  const inner = h("div", { class: "check-inner" });
  const status = report.ok ? (report.complete ? "OK" : "OK so far, slides missing") : `${report.summary.errors} error(s)`;
  inner.append(h("div", { class: "check-head" },
    h("h1", { text: `Check: ${report.deck.title || "(untitled deck)"}` }),
    h("span", { class: `check-status ${report.ok ? "ok" : "bad"}`, text: status }),
    h("span", { class: "fine", text: `${report.deck.slides} slides · ${report.summary.warnings} warning(s) · ${TYPE_ID}` }),
  ));
  for (const [file, issues] of [["_type/slides.json", report.package.issues], ["project/deck.json", report.deck.issues]]) {
    if (!issues.length) continue;
    inner.append(h("div", { class: "check-row" }, h("div"), h("div", null, h("h2", { text: file }),
      h("ul", null, issues.map((item) => h("li", { class: item.level, text: item.message }))))));
  }
  results.forEach((slide, index) => {
    const slot = makeSlot();
    renderInto(slot, index, { thumb: true });
    const frame = slot.host.shadowRoot?.querySelector(".frame");
    const section = frame?.querySelector(":scope > section");
    if (section && slide.marks.length) {
      const all = [...section.querySelectorAll("*")];
      for (const at of slide.marks) all[at]?.classList.add("check-overflow");
    }
    if (frame && slide.safe && slide.status === "overflow") {
      frame.classList.add("check-safe-area");
      for (const side of ["top", "right", "bottom", "left"]) frame.style.setProperty(`--safe-${side}`, `${slide.safe[side]}px`);
    }
    inner.append(h("div", { class: "check-row", id: `check-${slide.id}` }, slot.slot, h("div", null,
      h("h2", null, `${String(slide.index).padStart(2, "0")} ${slide.title}`, h("code", { text: `${slide.file} · ${slide.status}` })),
      slide.issues.length
        ? h("ul", null, slide.issues.map((item) => h("li", { class: item.level, text: item.message })))
        : h("p", { class: "fine", text: slide.notes ? "No issues. Has speaker notes." : "No issues. No speaker notes." }),
    )));
  });
  inner.append(h("pre", { id: "slides-check-report", text: JSON.stringify(report, null, 2) }));
  releaseSlots(app);
  app.replaceChildren(h("div", { class: "check" }, inner));
}

function onDataChanged({ deckChanged, orderChanged, changedSlides, shownId }) {
  if (deckChanged) {
    applyTheme();
    if (!schemeChosen) setScheme(state.deck?.theme.scheme || activeTheme()?.scheme || "light");
  }
  if (state.deckStatus === "ok" && total()) {
    const keep = state.pendingId ?? shownId ?? currentId();
    const keepStep = state.pendingId != null ? state.pendingStep : state.step;
    state.pendingId = null;
    state.pendingStep = 0;
    const at = keep ? state.deck.order.indexOf(keep) : -1;
    state.index = at >= 0 ? at : Math.min(state.index, total() - 1);
    // A step belongs to its slide: a slide that took the place of a removed one starts at step 0.
    state.step = at >= 0 ? Math.min(keepStep, stepCount()) : 0;
    if (!CHECK) syncHash();
  }
  if (CHECK) {
    runCheck();
    return;
  }
  // Typing still waiting for its pause is settled before a remount, as go() does: a new version of the
  // edited slide wins and discards it; any other change keeps it, sent first so the new stage shows it.
  if (editing.on && editing.dirty) {
    if (changedSlides.has(editing.id)) {
      clearTimeout(editing.timer);
      editing.dirty = false;
    } else {
      flushEdit();
    }
  }
  // The current slide is remounted only when it changed, so a running app keeps its state.
  const full = deckChanged || orderChanged || changedSlides.has(currentId());
  view.render?.({ full });
  view.dataChanged?.({ deckChanged, orderChanged, changedSlides });
  reportOutline();
  reportSlide();
  if (overviewDialog && (deckChanged || orderChanged || changedSlides.size)) {
    if (state.deckStatus === "ok" && total()) overviewDialog.refresh();
    else overviewDialog.close();
  }
}

// PowerPoint export. PptxGenJS (a classic script that also defines JSZip) and the exporter load on the
// first export only. One export runs at a time; it reflects the slides as shown, local edits included.
let pptxLibrary = null;
let exportRunning = false;

function loadPptxLibrary() {
  pptxLibrary ||= new Promise((resolve, reject) => {
    const script = h("script", { src: `${TYPE_ROOT}vendor/pptxgen.bundle.js` });
    script.addEventListener("load", () => resolve({ PptxGenJS: window.PptxGenJS, JSZip: window.JSZip }), { once: true });
    script.addEventListener("error", () => {
      pptxLibrary = null;
      reject(new Error("vendor/pptxgen.bundle.js could not be loaded"));
    }, { once: true });
    document.head.append(script);
  });
  return pptxLibrary;
}

async function exportPptx(onProgress) {
  if (state.deckStatus !== "ok" || !total()) throw new Error("The presentation is not loaded");
  if (exportRunning) throw Object.assign(new Error("An export is already running"), { code: "export-busy" });
  exportRunning = true;
  try {
    const [{ PptxGenJS, JSZip }, { buildPptx }] = await Promise.all([loadPptxLibrary(), import(`${TYPE_ROOT}export-pptx.js`)]);
    const { bytes, warnings } = await buildPptx({
      PptxGenJS,
      JSZip,
      deck: { title: state.deck.title, lang: state.deck.lang, ids: [...state.deck.order] },
      mountStill: (index, host) => {
        mountFrame(host, buildFrame(index, { thumb: true }));
        return { notes: state.slides.get(state.deck.order[index])?.notes || "" };
      },
      waitForMedia,
      onProgress,
    });
    const base = (state.deck.title || t("slides")).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "slides";
    return { format: "pptx", filename: `${base}.pptx`, bytes, warnings };
  } finally {
    exportRunning = false;
  }
}

// The toolbar's export saves the file; a failure shows the error under the generic message.
async function downloadPptx() {
  const buttons = [...document.querySelectorAll(".export-btn")];
  for (const button of buttons) button.disabled = true;
  try {
    const result = await exportPptx((n, count) => { live.textContent = t("exporting", { n, total: count }); });
    const url = URL.createObjectURL(new Blob([result.bytes], { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }));
    const link = h("a", { href: url, download: result.filename, hidden: true });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (error) {
    showBanner(t("exportFailed"), String(error?.message || error));
  } finally {
    for (const button of buttons) button.disabled = false;
  }
}

function showBanner(text, detail) {
  document.querySelector(".update-banner")?.remove();
  const banner = h("div", { class: "update-banner", role: "alert" },
    h("span", null, text, detail ? h("small", { class: "banner-detail", text: detail }) : null),
    iconButton("close", t("close"), () => banner.remove()),
  );
  document.body.append(banner);
}

// Edit mode (embed only): the text blocks on the stage become editable as plain text. Each change is
// written back into the slide file's own markup, sanitized and sent to the host as `edited`, which
// saves the file. The viewer shows the edit at once and keeps it while refreshes still return older
// file versions; a version from another writer wins.
const editing = { enabled: false, on: false, frame: null, text: "", baseHtml: "", id: null, timer: null, dirty: false, baseline: "" };
let slideSelection = null;
let selectionCounter = 0;
const pendingEdits = new Map(); // slide id -> { base, posted: Set, latest, stale }
// A host that never saves an edit (a failed save, a lost message) must not pin it on the stage: after
// this many refreshes that still return an older file, the file wins again.
const PENDING_EDIT_REFRESHES = 3;
const EDIT_SKIP = "svg, math, iframe, video, audio, canvas, img, picture, object, embed, aside, style, select, textarea, input, button";
const EDIT_SHEET = new CSSStyleSheet();
EDIT_SHEET.replaceSync(`[data-slides-edit] { cursor: text; outline: none; }
[data-slides-edit]:hover { box-shadow: 0 0 0 3px color-mix(in oklab, var(--accent) 45%, transparent); border-radius: 6px; }`);

// Text blocks: the outermost elements with text whose content is inline only.
function editableBlocks(section) {
  const blocks = [];
  const inlineOnly = (el) => [...el.children].every((child) => child.localName === "br"
    || (!child.matches(EDIT_SKIP) && getComputedStyle(child).display.startsWith("inline") && inlineOnly(child)));
  const walk = (el) => {
    for (const child of el.children) {
      if (child.matches(EDIT_SKIP) || !child.hasAttribute(NODE_ATTR)) continue;
      if (/\S/.test(child.textContent) && inlineOnly(child)) blocks.push(child);
      else walk(child);
    }
  };
  if (section) walk(section);
  return blocks;
}

function stageTextBlock(event, host) {
  const blocks = editableBlocks(host.shadowRoot?.querySelector(".frame > section"));
  return event.composedPath().find((node) => blocks.includes(node));
}

function stageSelection(root) {
  return root?.getSelection?.() || window.getSelection();
}

function clearSlideSelection() {
  if (!slideSelection) return;
  slideSelection.observer.disconnect();
  slideSelection = null;
  postToHost("selection", { selection: null });
}

function reportSelection() {
  if (!editing.on || !editing.frame?.isConnected) return;
  // Parent toolbar focus may collapse the native selection; its captured range remains usable.
  if (!document.hasFocus()) return;
  const selection = stageSelection(editing.frame.getRootNode());
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  const element = range?.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range?.startContainer.parentElement;
  const block = element?.closest("[data-slides-edit]");
  if (!range || !block || !editing.frame.contains(block)) return clearSlideSelection();
  if (!block.contains(range.endContainer)) range.setEnd(block, block.childNodes.length);
  const text = range.toString();
  if (!text.trim()) return clearSlideSelection();
  const previous = slideSelection;
  if (previous && previous.range.startContainer === range.startContainer && previous.range.startOffset === range.startOffset
    && previous.range.endContainer === range.endContainer && previous.range.endOffset === range.endOffset && previous.text === text) return;
  clearSlideSelection();
  const rect = range.getBoundingClientRect(); // Already includes the 1920×1080 stage's CSS transform.
  const observer = new MutationObserver(clearSlideSelection);
  observer.observe(block, { subtree: true, childList: true, characterData: true, attributes: true });
  slideSelection = {
    id: currentId(), token: String(++selectionCounter), range: range.cloneRange(), block, text,
    markup: block.innerHTML, observer,
    startNode: range.startContainer, startOffset: range.startOffset, endNode: range.endContainer, endOffset: range.endOffset,
  };
  postToHost("selection", { id: slideSelection.id, token: slideSelection.token, text,
    rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } });
}

function replaceSlideSelection({ id, token, text }) {
  if (typeof id !== "string" || typeof token !== "string" || typeof text !== "string") return hostError("command-invalid", 'replace needs "id", "token" and "text" strings');
  const saved = slideSelection;
  if (!editing.enabled || !editing.on || !saved || saved.id !== id || saved.token !== token || currentId() !== id
    || !saved.block.isConnected || !editing.frame?.contains(saved.block) || saved.observer.takeRecords().length
    || saved.block.innerHTML !== saved.markup || saved.range.toString() !== saved.text
    || saved.range.startContainer !== saved.startNode || saved.range.startOffset !== saved.startOffset
    || saved.range.endContainer !== saved.endNode || saved.range.endOffset !== saved.endOffset) {
    clearSlideSelection();
    return hostError("selection-stale", "Slide selection changed; select the text again before replacing it");
  }
  clearSlideSelection();
  saved.range.deleteContents();
  saved.range.insertNode(document.createTextNode(text));
  stageSelection(editing.frame.getRootNode())?.removeAllRanges();
  editing.dirty = true;
  flushEdit();
}

document.addEventListener("selectionchange", reportSelection);
window.addEventListener("resize", clearSlideSelection);
document.addEventListener("scroll", clearSlideSelection, true);

// Tells the host how many blocks of the slide on the stage can be edited (0 for a slide that is not
// written yet or is malformed).
function makeEditable(host, index) {
  const id = state.deck.order[index];
  const slide = state.slides.get(id);
  const frame = host.shadowRoot?.querySelector(".frame");
  clearTimeout(editing.timer);
  Object.assign(editing, { frame: null, dirty: false });
  if (!frame || slide?.status !== "ok") {
    postToHost("editable", { id, count: 0 });
    return postToHost("editing", { on: true, id, count: 0 });
  }
  host.shadowRoot.adoptedStyleSheets = [...host.shadowRoot.adoptedStyleSheets, EDIT_SHEET];
  const blocks = editableBlocks(frame.querySelector(":scope > section"));
  for (const block of blocks) {
    block.setAttribute("contenteditable", "plaintext-only");
    block.setAttribute("data-slides-edit", "");
  }
  // The file text this frame was built from (its node numbers index that text's elements), and the
  // file this frame gives before any typing: only a different result is a hand edit.
  Object.assign(editing, { frame, id, text: slide.text, baseHtml: slide.text });
  editing.baseline = editSlideFile(slide.text, frame);
  frame.addEventListener("input", () => {
    clearSlideSelection();
    editing.dirty = true;
    clearTimeout(editing.timer);
    editing.timer = setTimeout(flushEdit, 800);
  });
  frame.addEventListener("focusout", flushEdit);
  postToHost("editable", { id, count: blocks.length });
  postToHost("editing", { on: true, id, count: blocks.length });
}

function flushEdit() {
  clearTimeout(editing.timer);
  if (!editing.frame?.isConnected || !editing.dirty) return;
  editing.dirty = false;
  const { id, baseHtml } = editing;
  const html = editSlideFile(editing.text, editing.frame);
  const slide = state.slides.get(id);
  if (!slide || html === editing.baseline) return;
  editing.baseline = html;
  editing.baseHtml = html;
  const pending = pendingEdits.get(id) || { base: baseHtml, posted: new Set(), latest: null, stale: 0 };
  pending.posted.add(html);
  pending.latest = html;
  pending.stale = 0;
  pendingEdits.set(id, pending);
  state.slides.set(id, { id, text: html, ...parseSlide(id, html) });
  postToHost("edited", { id, path: `project/slides/${id}.html`, html, baseHtml });
  view.dataChanged?.({ deckChanged: false, orderChanged: false, changedSlides: new Set([id]) });
  reportOutline();
}

// The file's section with the text of every edited block taken from the stage. Elements inside a
// block keep the file's own tag and attributes; markup the editor added is reduced to <br> and text.
// A <style> before the section, which rendering applies too, moves into the section.
function editSlideFile(fileText, frame) {
  const doc = new DOMParser().parseFromString(fileText, "text/html");
  const section = [...doc.body.children].find((node) => node.localName === "section");
  const sourceNodes = [...section.querySelectorAll("*")];
  const headStyles = [...doc.head.querySelectorAll("style")];
  const restore = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return [doc.createTextNode(node.data)];
    if (node.nodeType !== Node.ELEMENT_NODE) return [];
    const source = sourceNodes[Number(node.getAttribute(NODE_ATTR))];
    const children = [...node.childNodes].flatMap(restore);
    if (!node.hasAttribute(NODE_ATTR) || !source) return node.localName === "br" ? [doc.createElement("br")] : children;
    const copy = source.cloneNode(false);
    copy.append(...children);
    return [copy];
  };
  for (const block of frame.querySelectorAll("[data-slides-edit]")) {
    sourceNodes[Number(block.getAttribute(NODE_ATTR))]?.replaceChildren(...[...block.childNodes].flatMap(restore));
  }
  section.prepend(...headStyles);
  return `${sanitizeSlideFile(section)}\n`;
}

// The same sanitizer as rendering, in file mode. Slide CSS keeps its text as written: rendering sanitizes
// it on every load, and text parsed out of a <style> cannot contain the tag's end, so it writes back
// unchanged. Re-serializing the CSSOM instead would resolve escapes into markup.
function sanitizeSlideFile(section) {
  const styles = [...section.querySelectorAll("style")];
  for (const style of styles) style.remove();
  sanitizingFile = true;
  let clean;
  try {
    clean = purify.sanitize(section, PURIFY_CONFIG).querySelector("section");
  } finally {
    sanitizingFile = false;
  }
  for (const style of styles.reverse()) {
    const element = clean.ownerDocument.createElement("style");
    element.textContent = style.textContent;
    clean.prepend(element);
  }
  return clean.outerHTML;
}

function setEditing(on, host = null) {
  if (on === editing.on) return;
  clearSlideSelection();
  if (!on) flushEdit();
  editing.on = on;
  editing.frame = null;
  // Every step is shown while editing, so every text can be reached.
  if (on && state.deck) state.step = stepCount();
  if (state.deck) syncHash();
  if (on && host) {
    showStep(host);
    makeEditable(host, state.index);
  } else view.render?.({ full: true });
  if (!on) postToHost("editing", { on: false, id: currentId(), count: 0 });
}

// Embed mode's host protocol. The host frames /?embed=1&host=<its origin>#<slide id> and exchanges
// {slides: CONTRACT, type, ...} messages with the viewer. The envelope owns `slides` and `type`, so
// `ready` names the site type `siteType`, and `ready` and `outline` carry the outline as `outline`.
// Commands are taken only from the parent window at the host origin, and messages go only to the parent with the host origin as target, never "*";
// who may frame a private deck is Spot's frame-ancestors policy. Unknown types are ignored.
const embedHost = { ready: false, outline: "", slide: "" };

function postToHost(type, body, transfer = []) {
  if (HOST_ORIGIN && window.parent !== window) window.parent.postMessage({ ...body, slides: CONTRACT, type }, { targetOrigin: HOST_ORIGIN, transfer });
}

function deckOutline() {
  return {
    title: state.deck?.title || "",
    theme: { preset: activeThemeId, scheme: state.scheme },
    slides: state.deckStatus === "ok" ? state.deck.order.map((id, index) => ({
      id,
      title: state.slides.get(id)?.title || id,
      section: sectionAt(index)?.title ?? null,
      missing: state.slides.get(id)?.status === "missing",
    })) : [],
  };
}

// outline and slide are posted when they differ from the last one the host got.
function reportOutline() {
  if (!embedHost.ready) return;
  const outline = deckOutline();
  const text = JSON.stringify(outline);
  if (text === embedHost.outline) return;
  embedHost.outline = text;
  postToHost("outline", { outline });
}

function reportSlide() {
  if (!embedHost.ready || !currentId()) return;
  const slide = { id: currentId(), index: state.index };
  const text = JSON.stringify(slide);
  if (text === embedHost.slide) return;
  embedHost.slide = text;
  postToHost("slide", slide);
}

function announceReady() {
  const outline = deckOutline();
  embedHost.ready = true;
  embedHost.outline = JSON.stringify(outline);
  postToHost("ready", { contract: CONTRACT, siteType: { name: TYPE_NAME, version: TYPE_VERSION }, outline });
  reportSlide();
}

const hostError = (code, message) => postToHost("error", { code, message });

const HOST_COMMANDS = {
  goto({ id }) {
    if (typeof id !== "string") return hostError("command-invalid", 'goto needs an "id" string');
    if (!state.deck) return Object.assign(state, { pendingId: id, pendingStep: 0 });
    if (!state.deck.order.includes(id)) return hostError("slide-unknown", `There is no slide "${id}" in this deck`);
    goToId(id);
  },
  // The host makes this frame fullscreen itself; presenting is the stage alone, navigation unchanged.
  present({ on }) {
    if (typeof on !== "boolean") return hostError("command-invalid", 'present needs "on": true or false');
    app.classList.toggle("presenting", on);
  },
  print() {
    window.print();
  },
  edit({ on, enabled }) {
    if (typeof on !== "boolean") return hostError("command-invalid", 'edit needs "on": true or false');
    if (enabled !== undefined && typeof enabled !== "boolean") return hostError("command-invalid", 'edit "enabled" must be true or false');
    if (enabled !== undefined) editing.enabled = enabled;
    else if (on) editing.enabled = true; // A legacy host's edit-on is an explicit permission grant.
    setEditing(editing.enabled && on);
  },
  replace: replaceSlideSelection,
  "clear-selection"() {
    clearSlideSelection();
    if (editing.frame) stageSelection(editing.frame.getRootNode())?.removeAllRanges();
  },
  // Progress goes out per slide; the bytes are transferred, not copied.
  async export({ format }) {
    if (format !== "pptx") return hostError("command-invalid", 'export needs "format": "pptx"');
    try {
      const result = await exportPptx((done, count) => postToHost("exporting", { done, total: count }));
      postToHost("exported", result, [result.bytes]);
    } catch (error) {
      hostError(error?.code || "export-failed", String(error?.message || error));
    }
  },
  scheme({ scheme }) {
    if (scheme !== "light" && scheme !== "dark") return hostError("command-invalid", 'scheme needs "light" or "dark"');
    setScheme(scheme, { broadcast: true, chosen: true });
  },
};

if (HOST_ORIGIN) {
  window.addEventListener("message", (event) => {
    if (!event.source || event.origin !== HOST_ORIGIN) return;
    const data = event.data;
    if (!data || typeof data !== "object" || data.slides !== CONTRACT) return;
    if (data.type === "connect-sync" && event.ports.length === 1) {
      sync.connectHostPort(event.ports[0]);
      return;
    }
    if (event.source !== window.parent || !EMBED || !Object.hasOwn(HOST_COMMANDS, data.type)) return;
    HOST_COMMANDS[data.type](data);
  });
}

async function start() {
  try { sessionStorage.removeItem(`slides-reload:${TYPE_ID}`); } catch {}
  setScheme(userScheme || "light");
  const [css] = await Promise.all([fetch("/_type/slide.css").then((response) => {
    if (!response.ok) throw new Error(`slide.css: HTTP ${response.status}`);
    return response.text();
  }), loadThemes()]);
  slideSheet = new CSSStyleSheet();
  slideSheet.replaceSync(css);
  document.body.append(printRoot);
  view = CHECK ? {} : PRESENTER ? presenterView() : audienceView();
  view.render?.({});
  document.addEventListener("keydown", onKeyDown);
  const changed = await refresh(false);
  if (!changed) onDataChanged({ deckChanged: false, orderChanged: false, changedSlides: new Set() });
  app.removeAttribute("aria-busy");
  if (EMBED) announceReady();
  if (PRESENTER) sync.post({ kind: "hello" });
  connectDeployEvents();
  schedulePoll(true);
}

start();
