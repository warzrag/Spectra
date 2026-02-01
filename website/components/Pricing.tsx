import { Check } from 'lucide-react';

const plans = [
  {
    name: 'Free',
    nameColor: 'text-[#8b8b9e]',
    price: '$0',
    features: [
      '2 browser profiles',
      '1 team member',
      'Basic fingerprinting',
      'Community support',
    ],
    button: {
      label: 'Get Started',
      className:
        'w-full py-3 rounded-xl bg-[#16161f] text-[#b0b0c0] border border-[rgba(255,255,255,0.06)] font-medium transition-colors hover:bg-[#1c1c28]',
    },
    popular: false,
  },
  {
    name: 'Pro',
    nameColor: 'text-[#818cf8]',
    price: '$29',
    features: [
      '100 browser profiles',
      '5 team members',
      'Advanced fingerprinting',
      'Priority support',
      'Cookie import/export',
      'API access',
    ],
    button: {
      label: 'Upgrade to Pro',
      className:
        'w-full py-3 rounded-xl bg-gradient-to-r from-[#6366f1] to-[#7c3aed] text-white font-semibold shadow-lg shadow-indigo-500/25 transition-transform hover:scale-[1.02]',
    },
    popular: true,
  },
  {
    name: 'Enterprise',
    nameColor: 'text-[#f59e0b]',
    price: '$99',
    features: [
      'Unlimited profiles',
      'Unlimited members',
      'Premium fingerprinting',
      'Dedicated support',
      'Custom automation',
      'White-label option',
    ],
    button: {
      label: 'Contact Sales',
      className:
        'w-full py-3 rounded-xl bg-amber-400/10 text-amber-400 border border-amber-400/20 font-medium transition-colors hover:bg-amber-400/15',
    },
    popular: false,
  },
];

export default function Pricing() {
  return (
    <section id="pricing" className="py-24">
      <div className="max-w-6xl mx-auto px-6">
        {/* Header */}
        <div className="text-center">
          <h2 className="text-3xl md:text-4xl font-bold text-[#f0f0f5]">
            Simple, transparent pricing
          </h2>
          <p className="text-[#8b8b9e] text-lg mt-4">
            Start free, upgrade when you need more
          </p>
        </div>

        {/* Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mt-16 items-start">
          {plans.map((plan) => (
            <div
              key={plan.name}
              className={`relative rounded-2xl p-8 ${
                plan.popular
                  ? 'pricing-popular'
                  : 'bg-[#0f0f17] border border-[rgba(255,255,255,0.06)]'
              }`}
            >
              {/* Popular badge */}
              {plan.popular && (
                <span className="absolute -top-4 left-1/2 -translate-x-1/2 bg-gradient-to-r from-[#6366f1] to-[#8b5cf6] text-white text-xs px-4 py-1 rounded-full font-semibold">
                  Popular
                </span>
              )}

              {/* Plan name */}
              <p className={`text-lg font-semibold ${plan.nameColor}`}>
                {plan.name}
              </p>

              {/* Price */}
              <div className="mt-4 flex items-baseline gap-1">
                <span className="text-5xl font-black text-[#f0f0f5]">
                  {plan.price}
                </span>
                <span className="text-sm text-[#8b8b9e]">/month</span>
              </div>

              {/* Features */}
              <ul className="mt-8 space-y-4">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-center gap-3">
                    <Check className="w-5 h-5 text-[#10b981] shrink-0" />
                    <span className="text-[#b0b0c0] text-sm">{feature}</span>
                  </li>
                ))}
              </ul>

              {/* Button */}
              <button className={`mt-8 ${plan.button.className}`}>
                {plan.button.label}
              </button>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
