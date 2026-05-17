/**
 * Единый реестр локальных шрифтов из /public/fonts.
 * Чтобы добавить семейство: скопируйте .otf в public/fonts и допишите блок ниже.
 */
export interface FontWeightEntry {
  id: string;
  label: string;
  /** имя файла внутри public/fonts */
  file: string;
  /** значение для canvas CSS font-weight (число строкой) */
  cssWeight: string;
}

export interface FontFamilyEntry {
  id: string;
  displayName: string;
  /** уникальное CSS-имя семейства для FontFace / ctx.font */
  cssFamily: string;
  weights: FontWeightEntry[];
}

const f = (file: string, label: string, cssWeight: string, id?: string): FontWeightEntry => ({
  id: id ?? label.toLowerCase().replace(/\s+/g, '-'),
  label,
  file,
  cssWeight,
});

export const FONT_FAMILIES: FontFamilyEntry[] = [
  {
    id: 'ony-byte',
    displayName: 'ONY Byte',
    cssFamily: 'ONYByteLab',
    weights: [
      f('ONYByte-Thin.otf', 'Thin', '100'),
      f('ONYByte-Light.otf', 'Light', '300'),
      f('ONYByte-Regular.otf', 'Regular', '400'),
      f('ONYByte-Medium.otf', 'Medium', '500'),
      f('ONYByte-Bold.otf', 'Bold', '700'),
      f('ONYByte-Black.otf', 'Black', '900'),
      f('ONYByte-ThinItalic.otf', 'Thin Italic', '100', 'thin-italic'),
      f('ONYByte-LightItalic.otf', 'Light Italic', '300', 'light-italic'),
      f('ONYByte-Italic.otf', 'Italic', '400', 'italic'),
      f('ONYByte-MediumItalic.otf', 'Medium Italic', '500', 'medium-italic'),
      f('ONYByte-BoldItalic.otf', 'Bold Italic', '700', 'bold-italic'),
      f('ONYByte-BlackItalic.otf', 'Black Italic', '900', 'black-italic'),
    ],
  },
  {
    id: 'ony-lavr',
    displayName: 'ONY Lavr',
    cssFamily: 'ONYLavrLab',
    weights: [
      f('ONYLavr-UltraLight.otf', 'Ultra Light', '200', 'ultralight'),
      f('ONYLavr-Light.otf', 'Light', '300'),
      f('ONYLavr-Regular.otf', 'Regular', '400'),
      f('ONYLavr-Medium.otf', 'Medium', '500'),
      f('ONYLavr-Bold.otf', 'Bold', '700'),
      f('ONYLavr-UltraLightItalic.otf', 'Ultra Light Italic', '200', 'ultralight-italic'),
      f('ONYLavr-LightItalic.otf', 'Light Italic', '300', 'light-italic'),
      f('ONYLavr-Italic.otf', 'Italic', '400', 'italic'),
      f('ONYLavr-MediumItalic.otf', 'Medium Italic', '500', 'medium-italic'),
      f('ONYLavr-BoldItalic.otf', 'Bold Italic', '700', 'bold-italic'),
    ],
  },
  {
    id: 'ony-one',
    displayName: 'ONY One',
    cssFamily: 'ONYOneLab',
    weights: [
      f('ONYOne-Thin.otf', 'Thin', '100'),
      f('ONYOne-Light.otf', 'Light', '300'),
      f('ONYOne-Regular.otf', 'Regular', '400'),
      f('ONYOne-Medium.otf', 'Medium', '500'),
      f('ONYOne-Bold.otf', 'Bold', '700'),
      f('ONYOne-Black.otf', 'Black', '900'),
    ],
  },
  {
    id: 'ony-track-delete-j',
    displayName: 'ONY Track Delete J',
    cssFamily: 'ONYTrackDeleteJLab',
    weights: [
      f('ONYTrackDeleteJ-0-500.otf', '0 — 500', '400', 'j-0-500'),
      f('ONYTrackDeleteJ-250-500.otf', '250 — 500', '450', 'j-250-500'),
      f('ONYTrackDeleteJ-600-500.otf', '600 — 500', '500', 'j-600-500'),
      f('ONYTrackDeleteJ-800-500.otf', '800 — 500', '550', 'j-800-500'),
    ],
  },
  {
    id: 'ony-track-delete-kk',
    displayName: 'ONY Track Delete KK',
    cssFamily: 'ONYTrackDeleteKKLab',
    weights: [
      f('ONYTrackDeleteKK-0-500.otf', '0 — 500', '400', 'kk-0-500'),
      f('ONYTrackDeleteKK-250-500.otf', '250 — 500', '450', 'kk-250-500'),
      f('ONYTrackDeleteKK-600-500.otf', '600 — 500', '500', 'kk-600-500'),
      f('ONYTrackDeleteKK-800-500.otf', '800 — 500', '550', 'kk-800-500'),
    ],
  },
];

export function getFontFamilyById(id: string): FontFamilyEntry | undefined {
  return FONT_FAMILIES.find((ff) => ff.id === id);
}

export function fontUrlForFile(file: string): string {
  const base = import.meta.env.BASE_URL;
  return `${base}fonts/${file}`;
}
