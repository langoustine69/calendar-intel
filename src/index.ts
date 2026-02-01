import { createAgent } from '@lucid-agents/core';
import { http } from '@lucid-agents/http';
import { createAgentApp } from '@lucid-agents/hono';
import { payments, paymentsFromEnv } from '@lucid-agents/payments';
import { z } from 'zod';
import { readFileSync, existsSync } from 'fs';

const agent = await createAgent({
  name: 'calendar-intel',
  version: '1.0.0',
  description: 'Public holiday data for scheduling agents - holidays, business days, and calendar intelligence',
})
  .use(http())
  .use(payments({ config: paymentsFromEnv() }))
  .build();

const { app, addEntrypoint } = await createAgentApp(agent);

// === HELPERS ===
const NAGER_BASE = 'https://date.nager.at/api/v3';

async function fetchJSON(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  return response.json();
}

async function getHolidays(country: string, year: number): Promise<any[]> {
  return fetchJSON(`${NAGER_BASE}/publicholidays/${year}/${country}`);
}

async function getCountries(): Promise<any[]> {
  return fetchJSON(`${NAGER_BASE}/AvailableCountries`);
}

function isWeekend(date: Date): boolean {
  const day = date.getDay();
  return day === 0 || day === 6;
}

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

function parseDate(dateStr: string): Date {
  return new Date(dateStr + 'T00:00:00Z');
}

// === FREE: Overview - Today's holidays worldwide ===
addEntrypoint({
  key: 'overview',
  description: 'Free overview - check which countries have a holiday today',
  input: z.object({}),
  price: { amount: 0 },
  handler: async () => {
    const today = formatDate(new Date());
    const year = new Date().getFullYear();
    const countries = await getCountries();
    
    const holidaysToday: any[] = [];
    
    // Check a sample of major countries
    const majorCountries = ['US', 'GB', 'DE', 'FR', 'JP', 'AU', 'CA', 'IN', 'BR', 'CN'];
    
    for (const cc of majorCountries) {
      try {
        const holidays = await getHolidays(cc, year);
        const todayHoliday = holidays.find((h: any) => h.date === today);
        if (todayHoliday) {
          holidaysToday.push({
            country: cc,
            holiday: todayHoliday.name,
            localName: todayHoliday.localName
          });
        }
      } catch (e) {
        // Skip if country data unavailable
      }
    }
    
    return {
      output: {
        date: today,
        holidaysToday,
        countriesChecked: majorCountries.length,
        totalCountriesAvailable: countries.length,
        fetchedAt: new Date().toISOString(),
        dataSource: 'Nager.Date API (live)'
      }
    };
  },
});

// === PAID 1: Country holidays for a year ($0.001) ===
addEntrypoint({
  key: 'country-holidays',
  description: 'Get all public holidays for a country in a given year',
  input: z.object({
    country: z.string().length(2).describe('ISO 3166-1 alpha-2 country code (e.g., US, GB, DE)'),
    year: z.number().int().min(2000).max(2100).optional().default(2026)
  }),
  price: { amount: 1000 },
  handler: async (ctx) => {
    const holidays = await getHolidays(ctx.input.country.toUpperCase(), ctx.input.year);
    
    return {
      output: {
        country: ctx.input.country.toUpperCase(),
        year: ctx.input.year,
        holidays: holidays.map((h: any) => ({
          date: h.date,
          name: h.name,
          localName: h.localName,
          global: h.global,
          types: h.types
        })),
        totalHolidays: holidays.length,
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

// === PAID 2: Is date a holiday ($0.001) ===
addEntrypoint({
  key: 'is-holiday',
  description: 'Check if a specific date is a public holiday in a country',
  input: z.object({
    country: z.string().length(2).describe('ISO 3166-1 alpha-2 country code'),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Date in YYYY-MM-DD format')
  }),
  price: { amount: 1000 },
  handler: async (ctx) => {
    const year = parseInt(ctx.input.date.split('-')[0]);
    const holidays = await getHolidays(ctx.input.country.toUpperCase(), year);
    const holiday = holidays.find((h: any) => h.date === ctx.input.date);
    const dateObj = parseDate(ctx.input.date);
    
    return {
      output: {
        country: ctx.input.country.toUpperCase(),
        date: ctx.input.date,
        isHoliday: !!holiday,
        isWeekend: isWeekend(dateObj),
        isBusinessDay: !holiday && !isWeekend(dateObj),
        holidayDetails: holiday ? {
          name: holiday.name,
          localName: holiday.localName,
          types: holiday.types
        } : null,
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

// === PAID 3: Next holiday ($0.002) ===
addEntrypoint({
  key: 'next-holiday',
  description: 'Get the next upcoming public holiday in a country',
  input: z.object({
    country: z.string().length(2).describe('ISO 3166-1 alpha-2 country code'),
    fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Start date (defaults to today)')
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const today = ctx.input.fromDate || formatDate(new Date());
    const year = parseInt(today.split('-')[0]);
    
    // Get holidays for current and next year
    const [currentYearHolidays, nextYearHolidays] = await Promise.all([
      getHolidays(ctx.input.country.toUpperCase(), year),
      getHolidays(ctx.input.country.toUpperCase(), year + 1)
    ]);
    
    const allHolidays = [...currentYearHolidays, ...nextYearHolidays];
    const futureHolidays = allHolidays
      .filter((h: any) => h.date > today)
      .sort((a: any, b: any) => a.date.localeCompare(b.date));
    
    const nextHoliday = futureHolidays[0];
    
    if (!nextHoliday) {
      return {
        output: {
          country: ctx.input.country.toUpperCase(),
          fromDate: today,
          nextHoliday: null,
          message: 'No upcoming holidays found'
        }
      };
    }
    
    const daysUntil = Math.ceil(
      (parseDate(nextHoliday.date).getTime() - parseDate(today).getTime()) / (1000 * 60 * 60 * 24)
    );
    
    return {
      output: {
        country: ctx.input.country.toUpperCase(),
        fromDate: today,
        nextHoliday: {
          date: nextHoliday.date,
          name: nextHoliday.name,
          localName: nextHoliday.localName,
          daysUntil,
          types: nextHoliday.types
        },
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

// === PAID 4: Business days between dates ($0.002) ===
addEntrypoint({
  key: 'business-days',
  description: 'Calculate business days between two dates (excluding weekends and holidays)',
  input: z.object({
    country: z.string().length(2).describe('ISO 3166-1 alpha-2 country code'),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Start date YYYY-MM-DD'),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('End date YYYY-MM-DD')
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const startYear = parseInt(ctx.input.startDate.split('-')[0]);
    const endYear = parseInt(ctx.input.endDate.split('-')[0]);
    
    // Collect holidays for all years in range
    const holidayDates = new Set<string>();
    for (let year = startYear; year <= endYear; year++) {
      const holidays = await getHolidays(ctx.input.country.toUpperCase(), year);
      holidays.forEach((h: any) => holidayDates.add(h.date));
    }
    
    let businessDays = 0;
    let totalDays = 0;
    let weekendDays = 0;
    let holidayDaysCount = 0;
    
    const current = parseDate(ctx.input.startDate);
    const end = parseDate(ctx.input.endDate);
    
    while (current <= end) {
      totalDays++;
      const dateStr = formatDate(current);
      const weekend = isWeekend(current);
      const holiday = holidayDates.has(dateStr);
      
      if (weekend) weekendDays++;
      if (holiday && !weekend) holidayDaysCount++;
      if (!weekend && !holiday) businessDays++;
      
      current.setDate(current.getDate() + 1);
    }
    
    return {
      output: {
        country: ctx.input.country.toUpperCase(),
        startDate: ctx.input.startDate,
        endDate: ctx.input.endDate,
        businessDays,
        totalDays,
        weekendDays,
        holidayDays: holidayDaysCount,
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

// === PAID 5: Multi-country comparison ($0.003) ===
addEntrypoint({
  key: 'compare-countries',
  description: 'Compare holidays across multiple countries for a date range',
  input: z.object({
    countries: z.array(z.string().length(2)).min(2).max(5).describe('List of country codes'),
    year: z.number().int().min(2000).max(2100).optional().default(2026)
  }),
  price: { amount: 3000 },
  handler: async (ctx) => {
    const countryCodes = ctx.input.countries.map(c => c.toUpperCase());
    
    const results = await Promise.all(
      countryCodes.map(async (cc) => {
        const holidays = await getHolidays(cc, ctx.input.year);
        return {
          country: cc,
          totalHolidays: holidays.length,
          holidays: holidays.map((h: any) => ({
            date: h.date,
            name: h.name
          }))
        };
      })
    );
    
    // Find common holiday dates
    const allDates = results.flatMap(r => r.holidays.map((h: any) => h.date));
    const dateCounts = allDates.reduce((acc, date) => {
      acc[date] = (acc[date] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    const sharedHolidayDates = Object.entries(dateCounts)
      .filter(([_, count]) => count > 1)
      .map(([date]) => date)
      .sort();
    
    return {
      output: {
        year: ctx.input.year,
        countries: results,
        sharedHolidayDates,
        comparison: {
          mostHolidays: results.reduce((max, r) => r.totalHolidays > max.totalHolidays ? r : max).country,
          fewestHolidays: results.reduce((min, r) => r.totalHolidays < min.totalHolidays ? r : min).country
        },
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

// === PAID 6: Add business days ($0.003) ===
addEntrypoint({
  key: 'add-business-days',
  description: 'Calculate a future date by adding N business days',
  input: z.object({
    country: z.string().length(2).describe('ISO 3166-1 alpha-2 country code'),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Start date YYYY-MM-DD'),
    daysToAdd: z.number().int().min(1).max(365).describe('Number of business days to add')
  }),
  price: { amount: 3000 },
  handler: async (ctx) => {
    const startYear = parseInt(ctx.input.startDate.split('-')[0]);
    
    // Get holidays for multiple years to handle long spans
    const holidayDates = new Set<string>();
    for (let year = startYear; year <= startYear + 2; year++) {
      try {
        const holidays = await getHolidays(ctx.input.country.toUpperCase(), year);
        holidays.forEach((h: any) => holidayDates.add(h.date));
      } catch (e) {
        // Year might not be available
      }
    }
    
    const current = parseDate(ctx.input.startDate);
    let businessDaysAdded = 0;
    let totalDaysMoved = 0;
    
    while (businessDaysAdded < ctx.input.daysToAdd) {
      current.setDate(current.getDate() + 1);
      totalDaysMoved++;
      
      const dateStr = formatDate(current);
      if (!isWeekend(current) && !holidayDates.has(dateStr)) {
        businessDaysAdded++;
      }
    }
    
    return {
      output: {
        country: ctx.input.country.toUpperCase(),
        startDate: ctx.input.startDate,
        businessDaysAdded: ctx.input.daysToAdd,
        resultDate: formatDate(current),
        calendarDaysMoved: totalDaysMoved,
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

// Serve icon
app.get('/icon.png', async (c) => {
  if (existsSync('./icon.png')) {
    const icon = readFileSync('./icon.png');
    return new Response(icon, { headers: { 'Content-Type': 'image/png' } });
  }
  return c.text('Icon not found', 404);
});

// ERC-8004 registration file
app.get('/.well-known/erc8004.json', (c) => {
  const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN 
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : 'https://calendar-intel-production.up.railway.app';
  
  return c.json({
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "calendar-intel",
    description: "Public holiday data for scheduling agents - country holidays, business day calculations, and calendar intelligence. 1 free + 6 paid endpoints via x402.",
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

const port = Number(process.env.PORT ?? 3000);
console.log(`Calendar Intel agent running on port ${port}`);

export default { port, fetch: app.fetch };
