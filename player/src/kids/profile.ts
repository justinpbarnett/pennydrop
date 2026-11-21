import { h } from "../dom";
import { avatar } from "./svg";

interface ProfileRow {
  id: number;
  kind: string;
}

const KEY = "pennydrop.kids.profile";

function remembered(): number | null {
  try {
    const stored = localStorage.getItem(KEY);
    return stored === null ? null : Number(stored);
  } catch {
    return null;
  }
}

function remember(id: number): void {
  try {
    localStorage.setItem(KEY, String(id));
  } catch {
    return;
  }
}

async function listProfiles(): Promise<ProfileRow[]> {
  try {
    const response = await fetch("/api/profiles");
    return response.ok ? ((await response.json()) as ProfileRow[]) : [];
  } catch {
    return [];
  }
}

function pickByTap(profiles: ProfileRow[], panel: HTMLElement): Promise<number> {
  return new Promise((resolve) => {
    panel.replaceChildren(...profiles.map((profile) => {
      const button = h("button", { class: "avatar-choice", type: "button", "aria-label": `Profile ${profile.id}` }, avatar(profile.id));
      button.addEventListener("click", () => {
        panel.hidden = true;
        resolve(profile.id);
      });
      return button;
    }));
    panel.hidden = false;
  });
}

export async function chooseProfile(panel: HTMLElement): Promise<number | null> {
  const profiles = await listProfiles();
  const known = new Set(profiles.map((profile) => profile.id));
  const requested = new URLSearchParams(location.search).get("profile");
  const wanted = requested === null ? remembered() : Number(requested);
  let chosen: number | null = wanted !== null && known.has(wanted) ? wanted : null;
  if (chosen === null && profiles.length > 0) {
    const kids = profiles.filter((profile) => profile.kind === "kid");
    chosen = await pickByTap(kids.length > 0 ? kids : profiles, panel);
  }
  if (chosen !== null) {
    remember(chosen);
    history.replaceState(null, "", `?${new URLSearchParams({ profile: String(chosen) })}`);
  }
  return chosen;
}
