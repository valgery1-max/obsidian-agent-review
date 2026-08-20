import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve, sep } from "node:path";
import type { CodexLocalAttachment } from "./types";

const MIME_EXTENSIONS: Record<string, string> = {
  "image/bmp": ".bmp",
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "text/csv": ".csv",
  "text/plain": ".txt"
};

export function localPathForFile(file: File): string | undefined {
  const legacyPath = (file as File & { path?: string }).path;
  if (legacyPath) return legacyPath;
  try {
    const electron = require("electron") as { webUtils?: { getPathForFile?: (value: File) => string } };
    return electron.webUtils?.getPathForFile?.(file) || undefined;
  } catch {
    return undefined;
  }
}

export function clipboardFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const direct = [...data.files];
  if (direct.length > 0) return direct;
  return [...data.items]
    .filter((item) => item.kind === "file")
    .flatMap((item) => {
      const file = item.getAsFile();
      return file ? [file] : [];
    });
}

export function clipboardFileExtension(file: Pick<File, "name" | "type">): string {
  const fromName = extname(file.name).toLocaleLowerCase();
  if (/^\.[a-z0-9]{1,12}$/u.test(fromName)) return fromName;
  return MIME_EXTENSIONS[file.type.toLocaleLowerCase()] ?? "";
}

export class ClipboardAttachmentStore {
  private readonly directory = join(tmpdir(), "obsidian-codex-review", randomUUID());

  async resolve(file: File): Promise<CodexLocalAttachment> {
    const localPath = localPathForFile(file);
    if (localPath) return { name: basename(file.name || localPath), path: localPath };

    await mkdir(this.directory, { recursive: true });
    const extension = clipboardFileExtension(file);
    const path = join(this.directory, `${randomUUID()}${extension}`);
    await writeFile(path, Buffer.from(await file.arrayBuffer()));
    const fallback = file.type.startsWith("image/") ? `Изображение из буфера${extension}` : "Файл из буфера";
    return {
      name: basename(file.name) || fallback,
      path,
      temporary: true
    };
  }

  async remove(attachment: CodexLocalAttachment): Promise<void> {
    if (!attachment.temporary || !this.contains(attachment.path)) return;
    await rm(attachment.path, { force: true }).catch(() => undefined);
  }

  async dispose(): Promise<void> {
    await rm(this.directory, { recursive: true, force: true }).catch(() => undefined);
  }

  private contains(path: string): boolean {
    const root = `${resolve(this.directory)}${sep}`;
    return resolve(path).startsWith(root);
  }
}
