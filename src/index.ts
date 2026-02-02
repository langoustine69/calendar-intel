import { createAgent } from '@lucid-agents/core';
import { http } from '@lucid-agents/http';
import { createAgentApp } from '@lucid-agents/hono';
import { payments, paymentsFromEnv } from '@lucid-agents/payments';
import { analytics, getSummary, getAllTransactions, exportToCSV } from '@lucid-agents/analytics';
import { z } from 'zod';
import { readFileSync } from 'fs';

const agent = await createAgent({
  name: 'calendar-intel',
  version: '1.0.0',
  description: 'Calendar intelligence - public holidays, business days, historical events. Essential B2A data for scheduling agents.',
})
  .use(http())
  .use(payments({ config: paymentsFromEnv() }))
  .use(analytics())
  .build();

const { app, addEntrypoint } = await createAgentApp(agent);

// === HELPER: Fetch JSON from API ===
async function fetchJSON(url: string, headers?: Record<string, string>) {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  return response.json();
}

// === HELPER: Get ISO week number ===
function getISOWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

// === HELPER: Get day of year ===
function getDayOfYear(date: Date): number {
  const start = new Date(date.getFullYear(), 0, 0);
  const diff = date.getTime() - start.getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

// === HELPER: Check if date is weekend ===
function isWeekend(date: Date): boolean {
  const day = date.getDay();
  return day === 0 || day === 6;
}

// === HELPER: Format date as YYYY-MM-DD ===
function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

// === FREE ENDPOINT: Overview ===
addEntrypoint({
  key: 'overview',
  description: 'Free overview - today\'s calendar info and upcoming US holidays',
  input: z.object({}),
  price: "0.0001",
  handler: async () => {
    const today = new Date();
    const year = today.getFullYear();
    
    // Get US holidays for current year
    const holidays = await fetchJSON(`https://date.nager.at/api/v3/publicholidays/${year}/US`);
    
    // Find next upcoming holiday
    const todayStr = formatDate(today);
    const upcomingHolidays = holidays
      .filter((h: any) => h.date >= todayStr && h.global)
      .slice(0, 3);
    
    return {
      output: {
        today: {
          date: todayStr,
          dayOfWeek: today.toLocaleDateString('en-US', { weekday: 'long' }),
          dayOfYear: getDayOfYear(today),
          isoWeek: getISOWeek(today),
          isWeekend: isWeekend(today),
          quarter: Math.ceil((today.getMonth() + 1) / 3),
        },
        upcomingHolidays,
        fetchedAt: new Date().toISOString(),
        dataSource: 'Nager.Date API (live)',
        endpoints: {
          free: ['overview'],
          paid: ['holidays', 'on-this-day', 'week-info', 'business-days', 'report']
        }
      }
    };
  },
});

// === PAID ENDPOINT 1 ($0.001): Get holidays for any country/year ===
addEntrypoint({
  key: 'holidays',
  description: 'Get public holidays for any country and year',
  input: z.object({
    country: z.string().length(2).describe('ISO 3166-1 alpha-2 country code (e.g., US, GB, DE, AU)'),
    year: z.number().optional().describe('Year (default: current year)'),
    type: z.enum(['all', 'public', 'bank']).optional().default('all').describe('Filter by holiday type')
  }),
  price: "0.001",
  handler: async (ctx) => {
    const year = ctx.input.year || new Date().getFullYear();
    const country = ctx.input.country.toUpperCase();
    
    const holidays = await fetchJSON(`https://date.nager.at/api/v3/publicholidays/${year}/${country}`);
    
    let filtered = holidays;
    if (ctx.input.type === 'public') {
      filtered = holidays.filter((h: any) => h.global);
    } else if (ctx.input.type === 'bank') {
      filtered = holidays.filter((h: any) => h.types?.includes('Bank'));
    }
    
    return {
      output: {
        country,
        year,
        totalHolidays: filtered.length,
        holidays: filtered.map((h: any) => ({
          date: h.date,
          name: h.name,
          localName: h.localName,
          isNational: h.global,
          types: h.types,
          dayOfWeek: new Date(h.date).toLocaleDateString('en-US', { weekday: 'long' })
        })),
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

// === PAID ENDPOINT 2 ($0.001): On this day - historical events ===
addEntrypoint({
  key: 'on-this-day',
  description: 'Historical events that happened on a specific date',
  input: z.object({
    month: z.number().min(1).max(12).describe('Month (1-12)'),
    day: z.number().min(1).max(31).describe('Day of month'),
    limit: z.number().optional().default(10).describe('Max events to return')
  }),
  price: "0.001",
  handler: async (ctx) => {
    const { month, day, limit } = ctx.input;
    const paddedMonth = String(month).padStart(2, '0');
    const paddedDay = String(day).padStart(2, '0');
    
    // Wikipedia On This Day API
    const url = `https://en.wikipedia.org/api/rest_v1/feed/onthisday/events/${paddedMonth}/${paddedDay}`;
    const data = await fetchJSON(url, { 'Accept': 'application/json' });
    
    const events = (data.events || []).slice(0, limit).map((e: any) => ({
      year: e.year,
      text: e.text,
      pages: e.pages?.map((p: any) => ({
        title: p.title,
        description: p.description
      })).slice(0, 2)
    }));
    
    return {
      output: {
        date: `${paddedMonth}-${paddedDay}`,
        eventCount: events.length,
        events,
        fetchedAt: new Date().toISOString(),
        dataSource: 'Wikipedia (live)'
      }
    };
  },
});

// === PAID ENDPOINT 3 ($0.001): Week info - ISO week calculations ===
addEntrypoint({
  key: 'week-info',
  description: 'Get ISO week number, day of year, and week details for any date',
  input: z.object({
    date: z.string().optional().describe('Date in YYYY-MM-DD format (default: today)')
  }),
  price: "0.001",
  handler: async (ctx) => {
    const date = ctx.input.date ? new Date(ctx.input.date) : new Date();
    
    // Calculate week start (Monday) and end (Sunday)
    const dayOfWeek = date.getDay();
    const diff = date.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
    const weekStart = new Date(date);
    weekStart.setDate(diff);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    
    // Days until end of year
    const endOfYear = new Date(date.getFullYear(), 11, 31);
    const daysRemaining = Math.ceil((endOfYear.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
    
    return {
      output: {
        date: formatDate(date),
        dayOfWeek: date.toLocaleDateString('en-US', { weekday: 'long' }),
        dayOfYear: getDayOfYear(date),
        daysRemainingInYear: daysRemaining,
        isoWeek: getISOWeek(date),
        isoYear: date.getFullYear(),
        weekStart: formatDate(weekStart),
        weekEnd: formatDate(weekEnd),
        quarter: Math.ceil((date.getMonth() + 1) / 3),
        isWeekend: isWeekend(date),
        isLeapYear: (date.getFullYear() % 4 === 0 && date.getFullYear() % 100 !== 0) || date.getFullYear() % 400 === 0,
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

// === PAID ENDPOINT 4 ($0.002): Business days calculator ===
addEntrypoint({
  key: 'business-days',
  description: 'Calculate business days between dates, excluding weekends and holidays',
  input: z.object({
    startDate: z.string().describe('Start date in YYYY-MM-DD format'),
    endDate: z.string().describe('End date in YYYY-MM-DD format'),
    country: z.string().length(2).optional().default('US').describe('Country code for holidays')
  }),
  price: "0.002",
  handler: async (ctx) => {
    const start = new Date(ctx.input.startDate);
    const end = new Date(ctx.input.endDate);
    const country = ctx.input.country.toUpperCase();
    
    // Get holidays for relevant years
    const startYear = start.getFullYear();
    const endYear = end.getFullYear();
    const holidaySet = new Set<string>();
    
    for (let year = startYear; year <= endYear; year++) {
      try {
        const holidays = await fetchJSON(`https://date.nager.at/api/v3/publicholidays/${year}/${country}`);
        holidays.forEach((h: any) => holidaySet.add(h.date));
      } catch (e) {
        // Ignore if country not supported
      }
    }
    
    // Count business days
    let businessDays = 0;
    let totalDays = 0;
    let weekends = 0;
    let holidays = 0;
    const current = new Date(start);
    
    while (current <= end) {
      totalDays++;
      const dateStr = formatDate(current);
      
      if (isWeekend(current)) {
        weekends++;
      } else if (holidaySet.has(dateStr)) {
        holidays++;
      } else {
        businessDays++;
      }
      
      current.setDate(current.getDate() + 1);
    }
    
    return {
      output: {
        startDate: formatDate(start),
        endDate: formatDate(end),
        country,
        totalDays,
        businessDays,
        weekendDays: weekends,
        holidayDays: holidays,
        workWeeks: Math.floor(businessDays / 5),
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

// === PAID ENDPOINT 5 ($0.003): Full calendar report ===
addEntrypoint({
  key: 'report',
  description: 'Comprehensive calendar report - holidays, week info, business days for a date range',
  input: z.object({
    startDate: z.string().describe('Start date in YYYY-MM-DD format'),
    endDate: z.string().describe('End date in YYYY-MM-DD format'),
    country: z.string().length(2).optional().default('US').describe('Country code')
  }),
  price: "0.003",
  handler: async (ctx) => {
    const start = new Date(ctx.input.startDate);
    const end = new Date(ctx.input.endDate);
    const country = ctx.input.country.toUpperCase();
    
    // Get holidays
    const startYear = start.getFullYear();
    const endYear = end.getFullYear();
    const allHolidays: any[] = [];
    
    for (let year = startYear; year <= endYear; year++) {
      try {
        const holidays = await fetchJSON(`https://date.nager.at/api/v3/publicholidays/${year}/${country}`);
        allHolidays.push(...holidays);
      } catch (e) {
        // Continue
      }
    }
    
    // Filter holidays in range
    const holidaysInRange = allHolidays.filter(h => 
      h.date >= formatDate(start) && h.date <= formatDate(end) && h.global
    );
    
    // Calculate business days
    const holidaySet = new Set(allHolidays.map(h => h.date));
    let businessDays = 0;
    let totalDays = 0;
    let weekends = 0;
    const current = new Date(start);
    
    while (current <= end) {
      totalDays++;
      const dateStr = formatDate(current);
      if (isWeekend(current)) {
        weekends++;
      } else if (!holidaySet.has(dateStr)) {
        businessDays++;
      }
      current.setDate(current.getDate() + 1);
    }
    
    return {
      output: {
        period: {
          startDate: formatDate(start),
          endDate: formatDate(end),
          totalDays,
          businessDays,
          weekendDays: weekends,
          country
        },
        startDateInfo: {
          date: formatDate(start),
          dayOfWeek: start.toLocaleDateString('en-US', { weekday: 'long' }),
          isoWeek: getISOWeek(start),
          dayOfYear: getDayOfYear(start),
          quarter: Math.ceil((start.getMonth() + 1) / 3)
        },
        endDateInfo: {
          date: formatDate(end),
          dayOfWeek: end.toLocaleDateString('en-US', { weekday: 'long' }),
          isoWeek: getISOWeek(end),
          dayOfYear: getDayOfYear(end),
          quarter: Math.ceil((end.getMonth() + 1) / 3)
        },
        holidays: holidaysInRange.map(h => ({
          date: h.date,
          name: h.name,
          dayOfWeek: new Date(h.date).toLocaleDateString('en-US', { weekday: 'long' })
        })),
        generatedAt: new Date().toISOString()
      }
    };
  },
});

// === ANALYTICS ENDPOINTS ===
addEntrypoint({
  key: 'analytics',
  description: 'Payment analytics summary',
  input: z.object({
    windowMs: z.number().optional().describe('Time window in ms')
  }),
  price: "0.0001",
  handler: async (ctx) => {
    const tracker = agent.analytics?.paymentTracker;
    if (!tracker) {
      return { output: { error: 'Analytics not available', payments: [] } };
    }
    const summary = await getSummary(tracker, ctx.input.windowMs);
    return { 
      output: { 
        ...summary,
        outgoingTotal: summary.outgoingTotal.toString(),
        incomingTotal: summary.incomingTotal.toString(),
        netTotal: summary.netTotal.toString(),
      } 
    };
  },
});

addEntrypoint({
  key: 'analytics-transactions',
  description: 'Recent payment transactions',
  input: z.object({
    windowMs: z.number().optional(),
    limit: z.number().optional().default(50)
  }),
  price: "0.0001",
  handler: async (ctx) => {
    const tracker = agent.analytics?.paymentTracker;
    if (!tracker) {
      return { output: { transactions: [] } };
    }
    const txs = await getAllTransactions(tracker, ctx.input.windowMs);
    return { output: { transactions: txs.slice(0, ctx.input.limit) } };
  },
});

// === ERC-8004 Registration Endpoint ===
app.get('/.well-known/erc8004.json', (c) => {
  const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN 
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : 'https://calendar-intel-production.up.railway.app';
  
  return c.json({
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "calendar-intel",
    description: "Calendar intelligence - public holidays worldwide, business day calculations, historical events. Essential B2A data for scheduling and planning agents. Pricing: $0.001-0.003/request.",
    image: `${baseUrl}/icon.png`,
    services: [
      { name: "web", endpoint: baseUrl },
      { name: "A2A", endpoint: `${baseUrl}/.well-known/agent.json`, version: "0.3.0" }
    ],
    x402Support: true,
    active: true,
    registrations: [],
    supportedTrust: ["reputation"]
  });
});

// === Icon endpoint ===
app.get('/icon.png', async (c) => {
  try {
    const icon = readFileSync('./icon.png');
    return new Response(icon, {
      headers: { 'Content-Type': 'image/png' }
    });
  } catch (e) {
    return c.text('Icon not found', 404);
  }
});

const port = Number(process.env.PORT ?? 3000);
console.log(`Calendar Intel Agent running on port ${port}`);

export default { port, fetch: app.fetch };
