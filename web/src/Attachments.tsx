import { ImagePlus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { t } from '../../src/shared/i18n';
import { IMAGE_BACKENDS, IMAGE_TYPES, MAX_MESSAGE_IMAGES, type AgentBackend } from '../../src/shared/types';
import { toast } from './lib';

/** Photos are shrunk to this many pixels on the long side, which is more than models look at anyway. */
const MAX_SIDE = 2000;
/** Smaller files that fit are sent as they are, so a screenshot keeps its sharp text. */
const KEEP_BYTES = 1.5 * 1024 * 1024;

const readDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

/** A data URL the server accepts: one of its types, no larger than it needs to be. */
async function prepare(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= KEEP_BYTES && Object.hasOwn(IMAGE_TYPES, file.type)) {
    bitmap.close();
    return readDataUrl(file);
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  // PNG keeps transparency and text, unless that makes it larger than a JPEG would be by far.
  const png = file.type === 'image/png' ? await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png')) : null;
  const blob = png && png.size <= KEEP_BYTES ? png : await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.88));
  if (!blob) throw new Error(t('无法读取这张图片'));
  return readDataUrl(blob);
}

export const canSeeImages = (harness?: AgentBackend) => Boolean(harness && IMAGE_BACKENDS.includes(harness));

/** Whichever message box was shown last takes image files dropped anywhere on the page. */
let dropTarget: ((files: File[]) => void) | null = null;

export function takeImageDrop(files: File[]): boolean {
  const images = files.filter((f) => f.type.startsWith('image/'));
  if (!images.length || images.length !== files.length || !dropTarget) return false;
  dropTarget(images);
  return true;
}

export const acceptsImageDrop = () => Boolean(dropTarget);

/** Images waiting to go with the next message. */
export function useAttachments(harness?: AgentBackend) {
  const [images, setImages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const enabled = canSeeImages(harness);
  const latest = useRef(images);
  latest.current = images;

  const add = async (files: File[]) => {
    const picked = files.filter((f) => f.type.startsWith('image/'));
    if (!picked.length) return;
    if (!enabled) {
      toast(t('{agent} 不能读取图片', { agent: harness ?? 'AI' }), 'error');
      return;
    }
    const room = MAX_MESSAGE_IMAGES - latest.current.length;
    if (picked.length > room) toast(t('一条消息最多附带 {count} 张图片', { count: MAX_MESSAGE_IMAGES }), 'error');
    if (room <= 0) return;
    setBusy(true);
    try {
      const urls = await Promise.all(picked.slice(0, room).map(prepare));
      setImages((current) => [...current, ...urls].slice(0, MAX_MESSAGE_IMAGES));
    } catch {
      toast(t('无法读取这张图片'), 'error');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const target = (files: File[]) => void add(files);
    dropTarget = target;
    return () => {
      if (dropTarget === target) dropTarget = null;
    };
  });

  return {
    images,
    busy,
    enabled,
    add,
    remove: (index: number) => setImages((current) => current.filter((_, i) => i !== index)),
    clear: () => setImages([]),
    /** Put back after a failed send. */
    restore: (urls: string[]) => setImages(urls),
    /** For a textarea: a pasted image is attached instead of pasted as text. */
    onPaste: (e: React.ClipboardEvent) => {
      const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
      if (!files.length) return;
      e.preventDefault();
      void add(files);
    },
  };
}

export type Attachments = ReturnType<typeof useAttachments>;

export function AttachButton({ attachments, harness }: { attachments: Attachments; harness?: AgentBackend }) {
  const input = useRef<HTMLInputElement>(null);
  const full = attachments.images.length >= MAX_MESSAGE_IMAGES;
  const title = !attachments.enabled ? t('{agent} 不能读取图片', { agent: harness ?? 'AI' }) : full ? t('一条消息最多附带 {count} 张图片', { count: MAX_MESSAGE_IMAGES }) : t('添加图片');
  return (
    <>
      <button className="icon attach" type="button" title={title} aria-label={title} disabled={!attachments.enabled || full || attachments.busy} onClick={() => input.current?.click()}>
        <ImagePlus size={16} />
      </button>
      <input
        ref={input}
        type="file"
        accept={Object.keys(IMAGE_TYPES).join(',')}
        multiple
        hidden
        onChange={(e) => {
          void attachments.add([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />
    </>
  );
}

export function AttachmentStrip({ attachments }: { attachments: Attachments }) {
  if (!attachments.images.length) return null;
  return (
    <div className="attachments">
      {attachments.images.map((url, i) => (
        <div className="attachment" key={i}>
          <img src={url} alt={t('图片 {n}', { n: i + 1 })} />
          <button type="button" className="attachment-remove" title={t('移除图片')} aria-label={t('移除图片')} onClick={() => attachments.remove(i)}>
            <X size={11} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** The images a user sent, as stored with the chat. */
export function MessageImages({ sessionId, images }: { sessionId: string; images?: string[] }) {
  if (!images?.length) return null;
  return (
    <div className="msg-images">
      {images.map((name, i) => {
        const src = `/api/assistant/sessions/${sessionId}/images/${name}`;
        return (
          <a key={name} href={src} target="_blank" rel="noreferrer">
            <img src={src} alt={t('图片 {n}', { n: i + 1 })} loading="lazy" />
          </a>
        );
      })}
    </div>
  );
}
