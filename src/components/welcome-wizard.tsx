"use client";

import { useState, useEffect } from "react";

export interface WizardSlide {
  title: string;
  content: React.ReactNode;
}

interface Props {
  slides: WizardSlide[];
  sessionKey?: string;
}

export function WelcomeWizard({ slides, sessionKey = "welcome_seen" }: Props) {
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    if (!sessionStorage.getItem(sessionKey)) setOpen(true);
  }, [sessionKey]);

  function close() {
    sessionStorage.setItem(sessionKey, "1");
    setOpen(false);
  }

  if (!open) return null;

  const slide = slides[idx];
  const isLast = idx === slides.length - 1;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full p-8 flex flex-col gap-6">
        {/* Progress dots */}
        <div className="flex gap-2 justify-center">
          {slides.map((_, i) => (
            <button
              key={i}
              onClick={() => setIdx(i)}
              className={`w-2.5 h-2.5 rounded-full transition-colors ${i === idx ? "bg-blue-600" : "bg-gray-200 hover:bg-gray-300"}`}
            />
          ))}
        </div>

        <div className="min-h-[240px] flex flex-col gap-4">
          <h2 className="text-xl font-bold text-gray-900">{slide.title}</h2>
          <div className="text-gray-600 text-sm leading-relaxed flex-1">{slide.content}</div>
        </div>

        <div className="flex justify-between items-center">
          <button
            onClick={() => setIdx((i) => Math.max(0, i - 1))}
            disabled={idx === 0}
            className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 disabled:opacity-30"
          >
            ← Back
          </button>
          {isLast ? (
            <button
              onClick={close}
              className="px-6 py-2 bg-blue-600 text-white rounded-full text-sm font-semibold hover:bg-blue-700 transition-colors"
            >
              Get started
            </button>
          ) : (
            <button
              onClick={() => setIdx((i) => i + 1)}
              className="px-6 py-2 bg-blue-600 text-white rounded-full text-sm font-semibold hover:bg-blue-700 transition-colors"
            >
              Next →
            </button>
          )}
        </div>

        <button
          onClick={close}
          className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 text-xl leading-none"
        >
          ×
        </button>
      </div>
    </div>
  );
}
