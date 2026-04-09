const LETTERS = ["C", "l", "u", "e", "y"];

export default function ClueyWordmark({ className = "", showDotIo = false, uppercase = false }) {
  const labelBase = showDotIo ? "Cluey.io" : "Cluey";
  const ariaLabel = uppercase ? labelBase.toUpperCase() : labelBase;

  return (
    <span className={`cluey-wordmark ${className}`.trim()} aria-label={ariaLabel}>
      {LETTERS.map((letter, index) => (
        <span
          key={`${letter}-${index}`}
          className={`cluey-wordmark__letter cluey-wordmark__letter--${index + 1}`}
          aria-hidden="true"
        >
          {uppercase ? letter.toUpperCase() : letter}
        </span>
      ))}
      {showDotIo && (
        <span className="cluey-wordmark__suffix" aria-hidden="true">
          .io
        </span>
      )}
    </span>
  );
}
