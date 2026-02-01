'use client';

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';

const faqs = [
  {
    question: 'What is an antidetect browser?',
    answer:
      'An antidetect browser lets you create multiple isolated browser profiles, each with a unique fingerprint. This prevents websites from linking your accounts together through browser fingerprinting techniques like canvas, WebGL, and audio hashing.',
  },
  {
    question: 'Is Spectra free to use?',
    answer:
      'Yes! Spectra offers a free plan with 2 browser profiles and basic fingerprinting. For power users, our Pro and Enterprise plans unlock more profiles, team collaboration, and advanced features.',
  },
  {
    question: 'What platforms does Spectra support?',
    answer:
      'Spectra currently runs on Windows 10 and 11 (64-bit). macOS and Linux support are on our roadmap for future releases.',
  },
  {
    question: 'How does fingerprint protection work?',
    answer:
      'Each browser profile gets a unique combination of canvas noise, WebGL vendor/renderer, audio context, timezone, screen resolution, hardware specs, and WebRTC settings. This makes each profile appear as a completely different device to websites.',
  },
  {
    question: 'Can I use Spectra with my team?',
    answer:
      'Absolutely! Spectra supports team collaboration with Admin and Virtual Assistant roles. Admins can create profiles and assign them to team members, track activity logs, and manage permissions.',
  },
  {
    question: 'Is my data secure?',
    answer:
      'Your data is encrypted and synced via Firebase with real-time cloud synchronization. Browser profiles are stored locally in isolated directories, and proxy credentials are encrypted at rest.',
  },
];

export default function FAQ() {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  const toggle = (index: number) => {
    setOpenIndex(openIndex === index ? null : index);
  };

  return (
    <section id="faq" className="py-24">
      <div className="max-w-3xl mx-auto px-6">
        <div className="text-center">
          <h2 className="text-3xl md:text-4xl font-bold text-[#f0f0f5]">
            Frequently Asked Questions
          </h2>
          <p className="text-[#8b8b9e] text-lg mt-4">
            Everything you need to know about Spectra
          </p>
        </div>

        <div className="mt-12 space-y-4">
          {faqs.map((faq, index) => (
            <div
              key={index}
              className="rounded-xl overflow-hidden"
              style={{
                backgroundColor: '#0f0f17',
                border: '1px solid rgba(255, 255, 255, 0.06)',
              }}
            >
              <button
                onClick={() => toggle(index)}
                className="w-full text-left px-6 py-5 flex items-center justify-between text-[15px] font-medium text-[#f0f0f5]"
              >
                {faq.question}
                <ChevronDown
                  className="w-5 h-5 text-[#8b8b9e] transition-transform"
                  style={{
                    transform: openIndex === index ? 'rotate(180deg)' : 'rotate(0deg)',
                  }}
                />
              </button>

              <div className={`faq-answer${openIndex === index ? ' open' : ''}`}>
                <div>
                  <p className="px-6 pb-5 text-[14px] text-[#8b8b9e] leading-relaxed">
                    {faq.answer}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
