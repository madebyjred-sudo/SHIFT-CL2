/**
 * docxAssetExport — genera un .docx CL2-branded a partir de un AssetContent.
 *
 * El AssetContent (contrato compartido con el pipeline HTML→PDF) se interpreta
 * como secciones de documento:
 *   kind='cover'   → portada (título centrado + subtítulo)
 *   kind='section' → Heading 1
 *   kind='content' → Heading 2 + body
 *   kind='quote'   → pullquote Cambria italic, border-left burgundy
 *   kind='cta'     → párrafo final destacado
 *   kind='stats'   → tabla 2 col (label | value)
 *   kind='alert'   → recommendation box
 *   kind='list'    → lista con bullets
 *   kind='comparison' → columnas como tabla
 *
 * GCS upload: sigue el patrón de podcastStorage.ts.
 * Retorna { export_url, filename, size_bytes, generated_at }.
 */

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  HeadingLevel,
  AlignmentType,
  Header,
  Footer,
  PageNumber,
  BorderStyle,
  WidthType,
  ShadingType,
  convertInchesToTwip,
  PageOrientation,
  SectionType,
  UnderlineType,
} from 'docx';
import { Storage, type Bucket } from '@google-cloud/storage';
import { withTimeout } from './resilience.js';
import { logger } from './logger.js';

// ─── Brand constants ──────────────────────────────────────────────────────────
const BURGUNDY = '7A2237';
const NAVY = '0E1745';
const BODY_COLOR = '1F2937';
const MID_GRAY = '6B7280';
const PAPER_BG = 'FAF5EC';
const LIGHT_GRAY = 'F3F4F6';

const CM_TO_TWIP = 567; // 1 cm ≈ 567 twips
const MARGIN_CM = 2.5;
const MARGIN = Math.round(MARGIN_CM * CM_TO_TWIP);

// ─── GCS ─────────────────────────────────────────────────────────────────────
const UPLOAD_TIMEOUT_MS = 60_000;
const SIGNED_URL_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 días

let _storage: Storage | null = null;
function assetBucket(): Bucket {
  if (!_storage) _storage = new Storage();
  const name = process.env.ASSET_GCS_BUCKET ?? process.env.PODCAST_GCS_BUCKET ?? 'cl2-assets';
  return _storage.bucket(name);
}

async function uploadAsset(
  userId: string,
  filename: string,
  buffer: Buffer,
): Promise<string> {
  const objectPath = `${userId}/docx/${filename}`;
  const file = assetBucket().file(objectPath);
  await withTimeout(
    () =>
      file.save(buffer, {
        contentType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        resumable: false,
        metadata: { cacheControl: 'private, max-age=86400' },
      }),
    { ms: UPLOAD_TIMEOUT_MS, label: 'gcs:upload_docx_asset' },
  );
  return `gs://${assetBucket().name}/${objectPath}`;
}

async function signAsset(gsPath: string): Promise<string> {
  const m = gsPath.match(/^gs:\/\/([^/]+)\/(.+)$/);
  if (!m) throw new Error(`bad gcs path: ${gsPath}`);
  const [, bucketName, objectPath] = m;
  const file = new Storage().bucket(bucketName).file(objectPath);
  const [url] = await file.getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: Date.now() + SIGNED_URL_TTL_MS,
  });
  return url;
}

// ─── Shared types (contrato con el pipeline de assets) ────────────────────────
export interface AssetItem {
  label: string;
  value: string;
  sub?: string;
}

export interface AssetColumn {
  head: string;
  title: string;
  bullets: string[];
}

export interface AssetAlert {
  kind: 'recommendation' | 'warning' | 'note';
  title: string;
  text: string;
}

export interface AssetSlide {
  idx: number;
  kind:
    | 'cover'
    | 'section'
    | 'content'
    | 'comparison'
    | 'quote'
    | 'cta'
    | 'stats'
    | 'list'
    | 'alert';
  eyebrow?: string;
  headline: string;
  body?: string;
  items?: AssetItem[];
  columns?: AssetColumn[];
  alert?: AssetAlert;
  meta?: { footerLeft?: string; footerRight?: string };
}

export interface AssetContent {
  title: string;
  subtitle?: string;
  slides: AssetSlide[];
}

export interface DocxOptions {
  tono?: string;
  audiencia?: string;
  marca?: string;
}

export interface DocxAssetInput {
  content: AssetContent;
  options?: DocxOptions;
  userId: string;
  workspaceId?: string;
}

export interface DocxAssetResult {
  export_url: string;
  filename: string;
  size_bytes: number;
  generated_at: string;
  /** gs:// path para persistencia en DB */
  gcs_path: string;
}

// ─── Inline markdown parser ───────────────────────────────────────────────────
// Parses *italic burgundy*, **bold** in body text.
// Returns an array of TextRun.
function parseBodyRuns(
  input: string,
  baseSize = 22,
): TextRun[] {
  const runs: TextRun[] = [];
  // Split on **bold** and *italic*
  const parts = input.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
  for (const part of parts) {
    if (!part) continue;
    if (/^\*\*[^*]+\*\*$/.test(part)) {
      runs.push(new TextRun({
        text: part.slice(2, -2),
        bold: true,
        size: baseSize,
        color: BODY_COLOR,
        font: { name: 'Calibri' },
      }));
    } else if (/^\*[^*]+\*$/.test(part)) {
      runs.push(new TextRun({
        text: part.slice(1, -1),
        italics: true,
        size: baseSize,
        color: BURGUNDY,
        font: { name: 'Calibri' },
      }));
    } else {
      runs.push(new TextRun({
        text: part,
        size: baseSize,
        color: BODY_COLOR,
        font: { name: 'Calibri' },
      }));
    }
  }
  return runs.length > 0 ? runs : [new TextRun({ text: input, size: baseSize, color: BODY_COLOR, font: { name: 'Calibri' } })];
}

// ─── Paragraph builders ───────────────────────────────────────────────────────

function coverTitlePara(title: string): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 400, after: 200 },
    children: [
      new TextRun({
        text: title,
        font: { name: 'Cambria' },
        size: 56, // 28pt
        bold: false,
        color: NAVY,
      }),
    ],
  });
}

function coverSubtitlePara(subtitle: string): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 100, after: 600 },
    children: [
      new TextRun({
        text: subtitle,
        font: { name: 'Cambria' },
        size: 40, // 20pt
        italics: true,
        color: BURGUNDY,
      }),
    ],
  });
}

function heading1Para(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 360, after: 120 },
    children: [
      new TextRun({
        text,
        font: { name: 'Cambria' },
        size: 56, // 28pt
        bold: false,
        color: NAVY,
      }),
    ],
  });
}

function heading2Para(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 240, after: 100 },
    children: [
      new TextRun({
        text,
        font: { name: 'Cambria' },
        size: 40, // 20pt
        bold: false,
        italics: false,
        color: NAVY,
      }),
    ],
  });
}

function heading3Para(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_3,
    spacing: { before: 180, after: 80 },
    children: [
      new TextRun({
        text,
        font: { name: 'Cambria' },
        size: 32, // 16pt
        italics: true,
        color: BURGUNDY,
      }),
    ],
  });
}

function bodyPara(text: string): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.BOTH,
    spacing: { line: 360, after: 120 }, // 1.5 line spacing ≈ 360 twips for 11pt
    children: parseBodyRuns(text, 22),
  });
}

function eyebrowPara(text: string): Paragraph {
  return new Paragraph({
    spacing: { before: 120, after: 40 },
    children: [
      new TextRun({
        text: text.toUpperCase(),
        font: { name: 'Consolas' },
        size: 18, // 9pt
        color: MID_GRAY,
        characterSpacing: 20,
        smallCaps: true,
      }),
    ],
  });
}

function bulletPara(text: string): Paragraph {
  return new Paragraph({
    bullet: { level: 0 },
    indent: { left: convertInchesToTwip(0.5), hanging: convertInchesToTwip(0.25) },
    spacing: { after: 80 },
    children: parseBodyRuns(text, 22),
  });
}

function pullquotePara(text: string): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.LEFT,
    indent: { left: CM_TO_TWIP }, // 1cm left indent
    spacing: { before: 200, after: 200 },
    border: {
      left: {
        color: BURGUNDY,
        style: BorderStyle.SINGLE,
        size: 12, // ~1.5pt
        space: 12,
      },
    },
    children: [
      new TextRun({
        text,
        font: { name: 'Cambria' },
        size: 28, // 14pt
        italics: true,
        color: BODY_COLOR,
      }),
    ],
  });
}

function ctaPara(text: string): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 360, after: 240 },
    border: {
      top: { color: BURGUNDY, style: BorderStyle.SINGLE, size: 6, space: 4 },
      bottom: { color: BURGUNDY, style: BorderStyle.SINGLE, size: 6, space: 4 },
    },
    children: [
      new TextRun({
        text,
        font: { name: 'Cambria' },
        size: 28, // 14pt
        bold: true,
        color: BURGUNDY,
      }),
    ],
  });
}

// ─── Recommendation box ───────────────────────────────────────────────────────
function recommendationBlock(alert: AssetAlert): Paragraph[] {
  const labelMap: Record<string, string> = {
    recommendation: 'RECOMENDACIÓN CL2',
    warning: 'ADVERTENCIA',
    note: 'NOTA',
  };
  const label = labelMap[alert.kind] ?? 'NOTA';

  return [
    // Label in small caps / consolas
    new Paragraph({
      spacing: { before: 240, after: 40 },
      border: {
        left: { color: BURGUNDY, style: BorderStyle.THICK, size: 24, space: 8 },
        top: { color: BURGUNDY, style: BorderStyle.SINGLE, size: 6, space: 4 },
        right: { color: BURGUNDY, style: BorderStyle.SINGLE, size: 6, space: 4 },
      },
      shading: { fill: PAPER_BG, type: ShadingType.SOLID, color: PAPER_BG },
      indent: { left: CM_TO_TWIP },
      children: [
        new TextRun({
          text: label,
          font: { name: 'Consolas' },
          size: 18,
          smallCaps: true,
          bold: true,
          color: BURGUNDY,
          characterSpacing: 20,
        }),
      ],
    }),
    new Paragraph({
      spacing: { after: 40 },
      border: {
        left: { color: BURGUNDY, style: BorderStyle.THICK, size: 24, space: 8 },
        right: { color: BURGUNDY, style: BorderStyle.SINGLE, size: 6, space: 4 },
      },
      shading: { fill: PAPER_BG, type: ShadingType.SOLID, color: PAPER_BG },
      indent: { left: CM_TO_TWIP },
      children: [
        new TextRun({
          text: alert.title,
          font: { name: 'Cambria' },
          size: 28,
          bold: true,
          color: NAVY,
        }),
      ],
    }),
    new Paragraph({
      spacing: { after: 240 },
      border: {
        left: { color: BURGUNDY, style: BorderStyle.THICK, size: 24, space: 8 },
        bottom: { color: BURGUNDY, style: BorderStyle.SINGLE, size: 6, space: 4 },
        right: { color: BURGUNDY, style: BorderStyle.SINGLE, size: 6, space: 4 },
      },
      shading: { fill: PAPER_BG, type: ShadingType.SOLID, color: PAPER_BG },
      indent: { left: CM_TO_TWIP },
      children: parseBodyRuns(alert.text, 22),
    }),
  ];
}

// ─── Stats table ──────────────────────────────────────────────────────────────
function statsTable(items: AssetItem[]): Table {
  const rows = items.map(
    (item) =>
      new TableRow({
        children: [
          new TableCell({
            width: { size: 60, type: WidthType.PERCENTAGE },
            borders: {
              top: { color: 'DDDDDD', style: BorderStyle.SINGLE, size: 4 },
              bottom: { color: 'DDDDDD', style: BorderStyle.SINGLE, size: 4 },
              left: { color: 'DDDDDD', style: BorderStyle.SINGLE, size: 4 },
              right: { color: 'DDDDDD', style: BorderStyle.SINGLE, size: 4 },
            },
            margins: {
              top: 80,
              bottom: 80,
              left: 120,
              right: 120,
            },
            children: [
              new Paragraph({
                children: [
                  new TextRun({
                    text: item.label,
                    font: { name: 'Calibri' },
                    size: 22,
                    color: BODY_COLOR,
                  }),
                ],
              }),
              ...(item.sub
                ? [
                    new Paragraph({
                      children: [
                        new TextRun({
                          text: item.sub,
                          font: { name: 'Consolas' },
                          size: 18,
                          color: MID_GRAY,
                          smallCaps: true,
                        }),
                      ],
                    }),
                  ]
                : []),
            ],
          }),
          new TableCell({
            width: { size: 40, type: WidthType.PERCENTAGE },
            borders: {
              top: { color: 'DDDDDD', style: BorderStyle.SINGLE, size: 4 },
              bottom: { color: 'DDDDDD', style: BorderStyle.SINGLE, size: 4 },
              left: { color: 'DDDDDD', style: BorderStyle.SINGLE, size: 4 },
              right: { color: 'DDDDDD', style: BorderStyle.SINGLE, size: 4 },
            },
            margins: {
              top: 80,
              bottom: 80,
              left: 120,
              right: 120,
            },
            shading: { fill: LIGHT_GRAY, type: ShadingType.SOLID, color: LIGHT_GRAY },
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  new TextRun({
                    text: item.value,
                    font: { name: 'Cambria' },
                    size: 24,
                    bold: true,
                    color: BURGUNDY,
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
  );

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows,
  });
}

// ─── Comparison table ─────────────────────────────────────────────────────────
function comparisonTable(columns: AssetColumn[]): Table {
  // Header row
  const headerRow = new TableRow({
    tableHeader: true,
    children: columns.map(
      (col) =>
        new TableCell({
          shading: { fill: NAVY, type: ShadingType.SOLID, color: NAVY },
          margins: { top: 80, bottom: 80, left: 120, right: 120 },
          borders: {
            top: { color: NAVY, style: BorderStyle.SINGLE, size: 4 },
            bottom: { color: NAVY, style: BorderStyle.SINGLE, size: 4 },
            left: { color: NAVY, style: BorderStyle.SINGLE, size: 4 },
            right: { color: NAVY, style: BorderStyle.SINGLE, size: 4 },
          },
          children: [
            new Paragraph({
              children: [
                new TextRun({ text: col.head, font: { name: 'Cambria' }, size: 22, bold: true, color: 'FFFFFF' }),
              ],
            }),
            new Paragraph({
              children: [
                new TextRun({ text: col.title, font: { name: 'Calibri' }, size: 20, italics: true, color: 'D1D5DB' }),
              ],
            }),
          ],
        }),
    ),
  });

  // Find max bullets
  const maxBullets = Math.max(...columns.map((c) => c.bullets.length), 0);
  const dataRows: TableRow[] = [];
  for (let i = 0; i < maxBullets; i++) {
    dataRows.push(
      new TableRow({
        children: columns.map(
          (col) =>
            new TableCell({
              margins: { top: 60, bottom: 60, left: 120, right: 120 },
              borders: {
                top: { color: 'DDDDDD', style: BorderStyle.SINGLE, size: 4 },
                bottom: { color: 'DDDDDD', style: BorderStyle.SINGLE, size: 4 },
                left: { color: 'DDDDDD', style: BorderStyle.SINGLE, size: 4 },
                right: { color: 'DDDDDD', style: BorderStyle.SINGLE, size: 4 },
              },
              children: [
                new Paragraph({
                  children: [
                    new TextRun({
                      text: col.bullets[i] ?? '',
                      font: { name: 'Calibri' },
                      size: 20,
                      color: BODY_COLOR,
                    }),
                  ],
                }),
              ],
            }),
        ),
      }),
    );
  }

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, ...dataRows],
  });
}

// ─── Slide → paragraphs ───────────────────────────────────────────────────────
function slideToElements(
  slide: AssetSlide,
): Array<Paragraph | Table> {
  const out: Array<Paragraph | Table> = [];

  switch (slide.kind) {
    case 'cover': {
      out.push(coverTitlePara(slide.headline));
      if (slide.body) out.push(coverSubtitlePara(slide.body));
      break;
    }

    case 'section': {
      if (slide.eyebrow) out.push(eyebrowPara(slide.eyebrow));
      out.push(heading1Para(slide.headline));
      if (slide.body) {
        for (const line of slide.body.split('\n').filter(Boolean)) {
          out.push(bodyPara(line));
        }
      }
      break;
    }

    case 'content': {
      if (slide.eyebrow) out.push(eyebrowPara(slide.eyebrow));
      out.push(heading2Para(slide.headline));
      if (slide.body) {
        for (const line of slide.body.split('\n').filter(Boolean)) {
          out.push(bodyPara(line));
        }
      }
      break;
    }

    case 'quote': {
      out.push(pullquotePara(slide.headline));
      if (slide.body) out.push(pullquotePara(slide.body));
      break;
    }

    case 'cta': {
      out.push(ctaPara(slide.headline));
      if (slide.body) out.push(bodyPara(slide.body));
      break;
    }

    case 'stats': {
      if (slide.eyebrow) out.push(eyebrowPara(slide.eyebrow));
      out.push(heading2Para(slide.headline));
      if (slide.items && slide.items.length > 0) {
        out.push(new Paragraph({ spacing: { before: 120 } }));
        out.push(statsTable(slide.items));
        out.push(new Paragraph({ spacing: { after: 200 } }));
      }
      if (slide.body) out.push(bodyPara(slide.body));
      break;
    }

    case 'list': {
      if (slide.eyebrow) out.push(eyebrowPara(slide.eyebrow));
      out.push(heading2Para(slide.headline));
      if (slide.body) out.push(bodyPara(slide.body));
      if (slide.items) {
        for (const item of slide.items) {
          out.push(bulletPara(`${item.label}${item.value ? ': ' + item.value : ''}${item.sub ? ' — ' + item.sub : ''}`));
        }
      }
      break;
    }

    case 'alert': {
      if (slide.eyebrow) out.push(eyebrowPara(slide.eyebrow));
      if (slide.alert) {
        out.push(...recommendationBlock(slide.alert));
      } else {
        out.push(heading3Para(slide.headline));
        if (slide.body) out.push(bodyPara(slide.body));
      }
      break;
    }

    case 'comparison': {
      if (slide.eyebrow) out.push(eyebrowPara(slide.eyebrow));
      out.push(heading2Para(slide.headline));
      if (slide.columns && slide.columns.length > 0) {
        out.push(new Paragraph({ spacing: { before: 120 } }));
        out.push(comparisonTable(slide.columns));
        out.push(new Paragraph({ spacing: { after: 200 } }));
      }
      break;
    }

    default: {
      out.push(heading2Para(slide.headline));
      if (slide.body) out.push(bodyPara(slide.body));
    }
  }

  return out;
}

// ─── Main export function ─────────────────────────────────────────────────────

export async function renderDocxAsset(
  input: DocxAssetInput,
): Promise<DocxAssetResult> {
  const { content, options = {}, userId } = input;

  const docTitle = content.title;
  const safeName = docTitle
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '_') || 'documento';

  // ── Build body elements ───────────────────────────────────────────────
  const children: Array<Paragraph | Table> = [];

  for (const slide of content.slides) {
    children.push(...slideToElements(slide));
  }

  // ── Metadata footer note (tono/audiencia si presentes) ────────────────
  if (options.tono || options.audiencia) {
    children.push(new Paragraph({ spacing: { before: 400 } }));
    children.push(
      new Paragraph({
        border: {
          top: { color: 'DDDDDD', style: BorderStyle.SINGLE, size: 4, space: 4 },
        },
        spacing: { before: 100, after: 60 },
        children: [
          new TextRun({
            text: [
              options.tono ? `Tono: ${options.tono}` : null,
              options.audiencia ? `Audiencia: ${options.audiencia}` : null,
              options.marca ? `Marca: ${options.marca}` : null,
            ]
              .filter(Boolean)
              .join(' · '),
            font: { name: 'Consolas' },
            size: 16,
            color: MID_GRAY,
            smallCaps: true,
            characterSpacing: 15,
          }),
        ],
      }),
    );
  }

  // ── Build Document ────────────────────────────────────────────────────
  const doc = new Document({
    title: docTitle,
    creator: 'CL2 Consultoría Estratégica',
    description: `Generado por CL2 · ${new Date().toLocaleDateString('es-CR')}`,
    styles: {
      paragraphStyles: [
        {
          id: 'Heading1',
          name: 'Heading 1',
          basedOn: 'Normal',
          next: 'Normal',
          run: {
            font: { name: 'Cambria' },
            size: 56,
            bold: false,
            color: NAVY,
          },
          paragraph: {
            spacing: { before: 360, after: 120 },
          },
        },
        {
          id: 'Heading2',
          name: 'Heading 2',
          basedOn: 'Normal',
          next: 'Normal',
          run: {
            font: { name: 'Cambria' },
            size: 40,
            bold: false,
            color: NAVY,
          },
          paragraph: {
            spacing: { before: 240, after: 100 },
          },
        },
        {
          id: 'Heading3',
          name: 'Heading 3',
          basedOn: 'Normal',
          next: 'Normal',
          run: {
            font: { name: 'Cambria' },
            size: 32,
            italics: true,
            color: BURGUNDY,
          },
          paragraph: {
            spacing: { before: 180, after: 80 },
          },
        },
        {
          id: 'Normal',
          name: 'Normal',
          run: {
            font: { name: 'Calibri' },
            size: 22,
            color: BODY_COLOR,
          },
          paragraph: {
            spacing: { line: 360, after: 120 },
          },
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: {
              // A4: 210mm × 297mm  → twips (1 twip = 1/1440 inch; 1 inch ≈ 25.4mm)
              width: Math.round((210 / 25.4) * 1440),
              height: Math.round((297 / 25.4) * 1440),
              orientation: PageOrientation.PORTRAIT,
            },
            margin: {
              top: MARGIN,
              bottom: MARGIN,
              left: MARGIN,
              right: MARGIN,
              header: 400,
              footer: 400,
            },
          },
          type: SectionType.NEXT_PAGE,
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                border: {
                  bottom: { color: BURGUNDY, style: BorderStyle.SINGLE, size: 6, space: 4 },
                },
                spacing: { after: 80 },
                children: [
                  new TextRun({
                    text: 'CL2 · CONSULTORÍA ESTRATÉGICA',
                    font: { name: 'Consolas' },
                    size: 16,
                    smallCaps: true,
                    characterSpacing: 20,
                    color: BURGUNDY,
                  }),
                ],
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                border: {
                  top: { color: 'DDDDDD', style: BorderStyle.SINGLE, size: 4, space: 4 },
                },
                spacing: { before: 80 },
                children: [
                  new TextRun({
                    text: `${docTitle} · página `,
                    font: { name: 'Calibri' },
                    size: 16,
                    color: MID_GRAY,
                  }),
                  new TextRun({
                    children: [PageNumber.CURRENT],
                    font: { name: 'Calibri' },
                    size: 16,
                    color: MID_GRAY,
                  }),
                  new TextRun({
                    text: ' de ',
                    font: { name: 'Calibri' },
                    size: 16,
                    color: MID_GRAY,
                  }),
                  new TextRun({
                    children: [PageNumber.TOTAL_PAGES],
                    font: { name: 'Calibri' },
                    size: 16,
                    color: MID_GRAY,
                  }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });

  // ── Render to buffer ──────────────────────────────────────────────────
  const buffer = await Packer.toBuffer(doc);
  const generated_at = new Date().toISOString();
  const filename = `${safeName}-cl2-${Date.now()}.docx`;

  // ── Upload to GCS ─────────────────────────────────────────────────────
  let export_url: string;
  let gcs_path: string;
  try {
    gcs_path = await uploadAsset(userId, filename, buffer);
    export_url = await signAsset(gcs_path);
  } catch (uploadErr) {
    logger.warn('docxAssetExport: gcs upload failed, returning data-url fallback', {
      userId,
      filename,
      error: (uploadErr as Error).message,
    });
    // Graceful degradation: embed base64 data-url so endpoint still works
    // even if GCS creds are absent (local dev / CI).
    gcs_path = `data:docx:${filename}`;
    export_url = `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${buffer.toString('base64')}`;
  }

  logger.info('docxAssetExport: generated', {
    userId,
    filename,
    bytes: buffer.length,
    slides: content.slides.length,
    tono: options.tono,
    audiencia: options.audiencia,
  });

  return {
    export_url,
    filename,
    size_bytes: buffer.length,
    generated_at,
    gcs_path,
  };
}
