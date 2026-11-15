import React from 'react';

/** The original NCode circle logo, with its side artwork and tagline removed. */
export function NCodeMark({ size = 24 }: { size?: number }) {
  return (
    <img
      src="./ncode-logo-circle.png"
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      style={{ display: 'block', width: size, height: size, objectFit: 'contain' }}
    />
  );
}
