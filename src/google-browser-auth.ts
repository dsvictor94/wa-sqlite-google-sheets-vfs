import type { GoogleBrowserSheetsConfig } from "./types.js";

export const SHEETS_DISCOVERY_DOC = "https://sheets.googleapis.com/$discovery/rest?version=v4";
export const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const DEFAULT_GOOGLE_SCOPES = `${SHEETS_SCOPE} ${DRIVE_FILE_SCOPE}`;

declare const gapi: any;
declare const google: any;

export class GoogleBrowserAuth {
  private tokenClient: any | undefined;

  constructor(private readonly config: GoogleBrowserSheetsConfig) {}

  async init(): Promise<void> {
    await Promise.all([
      loadScript("https://apis.google.com/js/api.js"),
      loadScript("https://accounts.google.com/gsi/client"),
    ]);

    await new Promise<void>((resolve, reject) => {
      gapi.load("client", async () => {
        try {
          await gapi.client.init({
            ...(this.config.apiKey ? { apiKey: this.config.apiKey } : {}),
            discoveryDocs: [SHEETS_DISCOVERY_DOC],
          });
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });

    this.tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: this.config.clientId,
      scope: this.config.scopes ?? DEFAULT_GOOGLE_SCOPES,
      callback: () => undefined,
    });
  }

  async authorize(prompt: "consent" | "" = ""): Promise<void> {
    if (!this.tokenClient) throw new Error("GoogleBrowserAuth.init() was not called");

    const existingToken = gapi.client.getToken?.();
    if (existingToken?.access_token && prompt !== "consent") return;

    await new Promise<void>((resolve, reject) => {
      this.tokenClient.callback = (response: any) => {
        if (response?.error) reject(response);
        else resolve();
      };

      this.tokenClient.requestAccessToken({
        prompt: prompt || (existingToken ? "" : "consent"),
      });
    });
  }

  signOut(): void {
    const token = gapi.client.getToken?.();
    if (token?.access_token) google.accounts.oauth2.revoke(token.access_token);
    gapi.client.setToken("");
  }
}

function loadScript(src: string): Promise<void> {
  if (document.querySelector(`script[src="${src}"]`)) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}
