/**
 * Get a file off the handset and into the rider's hands.
 *
 * ★ THE BLOB DOWNLOAD NEVER WORKED ON THE PHONE ★
 *
 * Everything exportable in this app used the same helper: make a Blob, make an
 * object URL, create an `<a download>`, click it. That is correct in a browser
 * and it is inert inside a Capacitor WebView — an Android WebView has no
 * download manager attached, so the click is swallowed and NOTHING HAPPENS. No
 * file, no error, no toast.
 *
 * Which is exactly what the field reported, in the one moment it mattered
 * most: a ride recorded, `Save .jsonl` pressed, and "kuch dikh nahi raha".
 * The GPX and GeoJSON exports have presumably been silently doing the same
 * thing for as long as they have existed, because they were only ever tried in
 * a desktop browser.
 *
 * ★ WRITE IT, THEN OFFER TO SHARE IT ★
 *
 * On the handset the file is written to the app's Documents directory — which
 * needs no runtime permission and survives the app closing — and then the
 * system share sheet is opened on it. That last part is the one that actually
 * gets the file to a laptop: the rider picks WhatsApp, or Drive, or Gmail, and
 * it is off the phone in one tap. A file sitting in an app-private directory
 * with no way to reach it would be the same failure wearing a hat.
 *
 * The browser path is unchanged, because in a browser the old way is right.
 */

export type SaveOutcome =
  | { kind: 'shared'; path: string }
  | { kind: 'saved'; path: string }
  | { kind: 'downloaded' }
  | { kind: 'failed'; reason: string };

/**
 * @returns what actually happened, so the caller can SAY so. A silent success
 *          and a silent failure look identical, and this whole file exists
 *          because of a silent failure.
 */
export async function saveTextFile(
  text: string,
  fileName: string,
  mime: string,
): Promise<SaveOutcome> {
  if (!text) return { kind: 'failed', reason: 'nothing to save' };

  let isNative = false;
  try {
    const { Capacitor } = await import('@capacitor/core');
    isNative = Capacitor.isNativePlatform();
  } catch {
    isNative = false;
  }

  if (!isNative) {
    try {
      const blob = new Blob([text], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
      return { kind: 'downloaded' };
    } catch (err) {
      return { kind: 'failed', reason: (err as Error).message };
    }
  }

  let path = '';
  try {
    const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
    const written = await Filesystem.writeFile({
      path: fileName,
      data: text,
      directory: Directory.Documents,
      encoding: Encoding.UTF8,
      recursive: true,
    });
    path = written.uri;
  } catch (err) {
    return { kind: 'failed', reason: (err as Error).message };
  }

  // ★ SHARING IS THE HALF THAT GETS IT OFF THE PHONE ★ A failure here is not a
  // failure of the save: the file is on disk either way, and saying where is
  // more useful than saying "error".
  try {
    const { Share } = await import('@capacitor/share');
    await Share.share({
      title: fileName,
      text: fileName,
      url: path,
      dialogTitle: 'Send the log',
    });
    return { kind: 'shared', path };
  } catch {
    return { kind: 'saved', path };
  }
}

/** A line the rider can read, from what actually happened. */
export function describeSave(outcome: SaveOutcome, fileName: string): string {
  switch (outcome.kind) {
    case 'shared':
      return `${fileName} — shared`;
    case 'saved':
      // Documents is where a file manager looks first, so naming it is enough.
      return `${fileName} saved to Documents`;
    case 'downloaded':
      return `${fileName} downloaded`;
    case 'failed':
      return `could not save: ${outcome.reason}`;
  }
}
