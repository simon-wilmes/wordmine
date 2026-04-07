export const PLAYER_NAME_MAX_LENGTH = 25;

// Single source of truth for name length tiers. Update these ranges to retune sizing.
export const PLAYER_NAME_LENGTH_SIZE_TIERS = [
  { min: 0, max: 14, key: "normal" },
  { min: 15, max: 19, key: "small" },
  { min: 20, max: 25, key: "tiny" },
];

const BRIGHT_COLOR_LUMINANCE_THRESHOLD = 0.56;

function parseColorToRgb(color) {
  if (!color || typeof color !== "string") return null;
  const raw = color.trim();

  const hexMatch = raw.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (hexMatch) {
    const hex = hexMatch[1];
    if (hex.length === 3) {
      return {
        r: parseInt(`${hex[0]}${hex[0]}`, 16),
        g: parseInt(`${hex[1]}${hex[1]}`, 16),
        b: parseInt(`${hex[2]}${hex[2]}`, 16)
      };
    }
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16)
    };
  }

  const rgbMatch = raw.match(/^rgba?\((\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*([0-9.]+))?\)$/i);
  if (rgbMatch) {
    return {
      r: Math.max(0, Math.min(255, Number(rgbMatch[1]))),
      g: Math.max(0, Math.min(255, Number(rgbMatch[2]))),
      b: Math.max(0, Math.min(255, Number(rgbMatch[3])))
    };
  }

  return null;
}

function isBrightColor(color) {
  const rgb = parseColorToRgb(color);
  if (!rgb) return false;
  const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  return luminance > BRIGHT_COLOR_LUMINANCE_THRESHOLD;
}

function getReadableTextColor(backgroundColor) {
  if (!backgroundColor) return "#ffffff";
  return isBrightColor(backgroundColor) ? "#0f1115" : "#ffffff";
}

function getNameTierKey(name, tiers = PLAYER_NAME_LENGTH_SIZE_TIERS) {
  const len = String(name || "").length;
  const tier = tiers.find((entry) => len >= entry.min && len <= entry.max);
  if (tier) return tier.key;
  return len > PLAYER_NAME_MAX_LENGTH ? "tiny" : "normal";
}

function buildNameStyle(color, withContrastBoost) {
  if (!color) return undefined;
  const style = { color };
  if (withContrastBoost && isBrightColor(color)) {
    // Keep player color while boosting readability on bright backgrounds.
    style.textShadow = "0 1px 2px rgba(0, 0, 0, 0.8)";
  }
  return style;
}

export function getPlayerNameRender(player, options = {}) {
  const {
    scaleByLength = true,
    withContrastBoost = true,
    tiers = PLAYER_NAME_LENGTH_SIZE_TIERS
  } = options;

  const name = String(player?.name || "");
  const classes = ["player-name"];
  if (scaleByLength) {
    classes.push(`name-tier-${getNameTierKey(name, tiers)}`);
  }

  return {
    text: name,
    className: classes.join(" "),
    style: buildNameStyle(player?.color, withContrastBoost)
  };
}

export function getPlayerNameRenderNoScale(player, options = {}) {
  return getPlayerNameRender(player, { ...options, scaleByLength: false });
}

export function getMarkerPillStyle(entry) {
  if (!entry?.color) return undefined;
  if (entry.state === "mark") {
    return {
      color: entry.color,
      borderColor: entry.color
    };
  }

  return {
    backgroundColor: entry.color,
    borderColor: entry.color,
    color: getReadableTextColor(entry.color),
    textShadow: "none"
  };
}
