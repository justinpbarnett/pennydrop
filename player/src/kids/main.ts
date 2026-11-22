import "../fonts.css";
import "./kids.css";
import { loadFonts } from "../boot";
import { loadMintedLabs } from "../minted";
import { applyThemeVars } from "../theme-css";
import { KidsApp } from "./app";
import { chooseProfile } from "./profile";

const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

applyThemeVars("kids");
document.addEventListener("gesturestart", (event) => event.preventDefault());
document.addEventListener("touchmove", (event) => event.preventDefault(), { passive: false });
document.addEventListener("contextmenu", (event) => event.preventDefault());

const profileId = await chooseProfile($("#avatars"));
const manifest = $<HTMLLinkElement>('link[rel="manifest"]');
if (profileId !== null) manifest.href = `/kids/manifest.webmanifest?profile=${profileId}`;
await loadMintedLabs();
const app = new KidsApp({
  stage: $<SVGSVGElement>("#stage"),
  frame: $(".kstage-frame"),
  face: $("#face"),
  why: $<HTMLButtonElement>("#why"),
  mic: $<HTMLButtonElement>("#mic"),
  play: $<HTMLButtonElement>("#play"),
  answers: $("#answers"),
}, profileId);
const lessonId = new URLSearchParams(location.search).get("lesson");
if (lessonId) app.show(lessonId);
await loadFonts();
