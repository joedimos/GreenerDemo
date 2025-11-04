require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server: SocketIOServer } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Mistral AI Configuration
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY || 'your-mistral-api-key-here';
const MISTRAL_API_URL = 'https://api.mistral.ai/v1/chat/completions';
const MISTRAL_MODEL = 'mistral-small-latest';

// ==================== MISTRAL AI AGENT ====================

class MistralAIAgent {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.conversationHistory = new Map();
  }

  async chat(messages, options = {}) {
    try {
      const response = await fetch(MISTRAL_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: options.model || MISTRAL_MODEL,
          messages: messages,
          temperature: options.temperature || 0.7,
          max_tokens: options.max_tokens || 1000,
          top_p: options.top_p || 1,
          safe_prompt: false
        })
      });

      if (!response.ok) {
        const errorData = await response.text();
        throw new Error(`Mistral API error (${response.status}): ${errorData}`);
      }

      const data = await response.json();
      return {
        success: true,
        content: data.choices[0].message.content,
        usage: data.usage,
        model: data.model
      };
    } catch (error) {
      console.error('Mistral API Error:', error);
      return {
        success: false,
        error: error.message,
        content: null
      };
    }
  }

  async analyzeCustomerIntent(message, customerContext) {
    const systemPrompt = `You are an AI assistant analyzing customer intent for a lawn care service.
Analyze the customer's message and determine their intent. Respond ONLY with a JSON object.

Available intents:
- schedule_service: Customer wants to book a service
- inquiry_pricing: Customer asking about costs
- inquiry_services: Customer asking what services are available
- report_issue: Customer reporting a problem with their lawn
- feedback: Customer providing feedback
- general_question: General lawn care advice

Customer context: ${JSON.stringify(customerContext)}

Respond with JSON only: {"intent": "intent_name", "confidence": 0.0-1.0, "entities": {}}`;

    const result = await this.chat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: message }
    ], { temperature: 0.3, max_tokens: 300 });

    if (result.success) {
      try {
        const jsonMatch = result.content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          return JSON.parse(jsonMatch[0]);
        }
      } catch (e) {
        console.error('Failed to parse intent:', e);
      }
    }

    return { intent: 'general_question', confidence: 0.5, entities: {} };
  }

  async generateCustomerResponse(message, customerContext, intent, conversationHistory = []) {
    const systemPrompt = `You are a helpful and professional lawn care customer service agent.

Customer Information:
- Name: ${customerContext.customer.name}
- Address: ${customerContext.customer.address}
- Tier: ${customerContext.customer.customer_tier}
- Current Issues: ${customerContext.customer.current_issues?.join(', ') || 'None'}

Service History:
${JSON.stringify(customerContext.customer.service_history || [], null, 2)}

Regional Insights:
${JSON.stringify(customerContext.regional_insights || [], null, 2)}

Seasonal Recommendations:
${JSON.stringify(customerContext.seasonal_recommendations || [], null, 2)}

Detected Intent: ${intent.intent}

Instructions:
- Be warm, professional, and helpful
- Reference their service history when relevant
- Provide specific lawn care advice based on their region and grass type
- If they want to schedule, explain next steps
- If reporting an issue, show empathy and offer solutions
- Keep responses concise but informative (2-4 paragraphs max)
- Use customer's name naturally in conversation`;

    const messages = [
      { role: 'system', content: systemPrompt },
      ...conversationHistory,
      { role: 'user', content: message }
    ];

    const result = await this.chat(messages, { temperature: 0.8 });
    return result;
  }

  async recommendWorker(site, workers, kgInsights) {
    const systemPrompt = `You are an AI workforce optimization specialist for a lawn care company.

Analyze the work site and available workers to provide intelligent recommendations.

Work Site Details:
${JSON.stringify(site, null, 2)}

Available Workers:
${JSON.stringify(workers.map(w => ({
  id: w.id,
  name: w.name,
  skills: w.skills,
  rating: w.rating,
  hourly_rate: w.hourly_rate,
  performance_metrics: w.performance_metrics,
  active_assignments: w.active_assignment_ids.length
})), null, 2)}

Knowledge Graph Insights:
${JSON.stringify(kgInsights, null, 2)}

Provide a recommendation in JSON format with:
{
  "recommended_worker_id": "worker_X",
  "reasoning": "Brief explanation",
  "alternative": "worker_Y",
  "risk_factors": ["factor1", "factor2"],
  "optimization_tips": ["tip1", "tip2"]
}`;

    const result = await this.chat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'Analyze and recommend the best worker for this job.' }
    ], { temperature: 0.4, max_tokens: 600 });

    if (result.success) {
      try {
        const jsonMatch = result.content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          return JSON.parse(jsonMatch[0]);
        }
      } catch (e) {
        console.error('Failed to parse recommendation:', e);
      }
    }

    return null;
  }

  async generateLawnCarePlan(customerData, regionalData) {
    const systemPrompt = `You are a certified lawn care specialist creating a personalized care plan.

Customer Property:
- Address: ${customerData.address}
- Current Issues: ${customerData.current_issues?.join(', ') || 'General maintenance'}

Regional Data:
${JSON.stringify(regionalData, null, 2)}

Create a comprehensive lawn care plan with:
1. Immediate actions needed (next 2 weeks)
2. Monthly maintenance schedule (next 3 months)
3. Seasonal recommendations
4. Estimated costs
5. Expected outcomes

Be specific and actionable. Format as clear sections.`;

    const result = await this.chat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'Create a personalized lawn care plan for this customer.' }
    ], { temperature: 0.7, max_tokens: 1500 });

    return result;
  }

  getConversationHistory(userId) {
    if (!this.conversationHistory.has(userId)) {
      this.conversationHistory.set(userId, []);
    }
    return this.conversationHistory.get(userId);
  }

  addToHistory(userId, role, content) {
    const history = this.getConversationHistory(userId);
    history.push({ role, content });
    
    if (history.length > 10) {
      this.conversationHistory.set(userId, history.slice(-10));
    }
  }

  clearHistory(userId) {
    this.conversationHistory.delete(userId);
  }
}

const aiAgent = new MistralAIAgent(MISTRAL_API_KEY);

// ==================== KNOWLEDGE GRAPH ====================

class LawnCareKnowledgeGraph {
  constructor() {
    this.data = {
      regions: {
        'Canton': {
          type: 'Region',
          climateZone: '6a',
          soilType: 'ClayLoam',
          commonWeeds: ['Crabgrass', 'Dandelion', 'Clover'],
          avgRainfall: 38.5
        },
        'Massillon': {
          type: 'Region', 
          climateZone: '6a',
          soilType: 'SandyLoam',
          commonWeeds: ['ChinchBugs', 'BrownPatch'],
          avgRainfall: 36.2
        }
      },
      soilTypes: {
        'ClayLoam': {
          drainage: 'Moderate',
          fertility: 'High',
          pH: 6.8,
          compatibleGrass: ['KentuckyBluegrass', 'Fescue']
        },
        'SandyLoam': {
          drainage: 'High', 
          fertility: 'Medium',
          pH: 6.2,
          compatibleGrass: ['Bermuda', 'Zoysia']
        }
      },
      grassTypes: {
        'KentuckyBluegrass': {
          maintenance: 'Medium',
          droughtTolerance: 'Low',
          idealMowingHeight: '2.5-3.5 inches'
        },
        'Bermuda': {
          maintenance: 'High',
          droughtTolerance: 'High', 
          idealMowingHeight: '1-2 inches'
        }
      },
      skills: {
        'Mowing': { difficulty: 1, certification: false },
        'Edging': { difficulty: 2, certification: false },
        'TreeTrimming': { difficulty: 4, certification: true },
        'Fertilizing': { difficulty: 3, certification: true }
      },
      seasons: {
        'Spring': {
          optimalActivities: ['Aeration', 'Fertilization', 'Overseeding'],
          commonIssues: ['WeedGrowth', 'ThatchBuildUp']
        },
        'Summer': {
          optimalActivities: ['RegularMowing', 'WeedControl', 'Irrigation'],
          commonIssues: ['DroughtStress', 'HeatDamage']
        }
      }
    };
  }

  query(pattern) {
    const results = [];
    
    if (pattern.includes('rdf:type lc:Region')) {
      Object.keys(this.data.regions).forEach(region => {
        results.push({
          subject: `lc:${region}`,
          predicate: 'rdf:type',
          object: 'lc:Region'
        });
      });
    }
    
    if (pattern.includes('lc:Spring lc:optimalActivities')) {
      this.data.seasons.Spring.optimalActivities.forEach(activity => {
        results.push({
          subject: 'lc:Spring',
          predicate: 'lc:optimalActivities',
          object: `lc:${activity}`
        });
      });
    }
    
    if (pattern.includes('?skill rdf:type lc:Skill')) {
      Object.keys(this.data.skills).forEach(skill => {
        results.push({
          subject: `skill:${skill}`,
          predicate: 'rdf:type',
          object: 'lc:Skill'
        });
      });
    }
    
    return results;
  }

  findRegionalExpertise(region) {
    const regionData = this.data.regions[region];
    if (!regionData) return [];
    
    return [
      { subject: `lc:${region}`, predicate: 'lc:commonWeeds', object: regionData.commonWeeds.join(', ') },
      { subject: `lc:${region}`, predicate: 'lc:soilType', object: `lc:${regionData.soilType}` }
    ];
  }

  getOptimalSeasonalActivities(season) {
    const seasonData = this.data.seasons[season];
    if (!seasonData) return [];
    
    return seasonData.optimalActivities.map(activity => ({
      subject: `lc:${season}`,
      predicate: 'lc:optimalActivities', 
      object: `lc:${activity}`
    }));
  }

  getSkillRequirements(skill) {
    const skillData = this.data.skills[skill];
    if (!skillData) return [];
    
    return [
      { subject: `skill:${skill}`, predicate: 'lc:difficulty', object: skillData.difficulty.toString() },
      { subject: `skill:${skill}`, predicate: 'lc:requiresCertification', object: skillData.certification.toString() }
    ];
  }
}

const kg = new LawnCareKnowledgeGraph();

// ==================== DATA STRUCTURES ====================

const workSites = [
  {
    id: 'site_1',
    address: '123 Main St, Canton, OH 44702',
    coords: { lat: 40.7989, lng: -81.3784 },
    difficulty_score: 0.8,
    status: 'open',
    preferred_skills: ['Mowing', 'Edging', 'Trimming'],
    estimated_hours: 3,
    property_size: 'large',
    terrain_type: 'hilly',
    grass_type: 'KentuckyBluegrass',
    regional_factors: ['ClayLoam'],
    historical_data: {
      avg_completion_time: 3.2,
      cost_overruns: 0.15,
      customer_rating: 4.3
    }
  },
  {
    id: 'site_2',
    address: '456 Oak Ave, Massillon, OH 44646',
    coords: { lat: 40.7967, lng: -81.5215 },
    difficulty_score: 0.4,
    status: 'open',
    preferred_skills: ['Mowing', 'Fertilizing'],
    estimated_hours: 1.5,
    property_size: 'medium',
    terrain_type: 'flat',
    grass_type: 'Bermuda',
    regional_factors: ['SandyLoam'],
    historical_data: {
      avg_completion_time: 1.4,
      cost_overruns: 0.02,
      customer_rating: 4.8
    }
  }
];

const workers = [
  {
    id: 'worker_1',
    name: 'John Smith',
    skills: ['Mowing', 'Edging', 'Trimming', 'Fertilizing'],
    home_coords: { lat: 40.8000, lng: -81.4000 },
    rating: 4.8,
    hourly_rate: 25,
    active_assignment_ids: [],
    certifications: ['PesticideApplicator', 'LandscapeDesign'],
    years_experience: 8,
    availability: 'full_time',
    performance_metrics: {
      efficiency_score: 0.92,
      quality_consistency: 0.88,
      customer_satisfaction: 4.8,
      specialization_factors: {
        LargeLawns: 0.95,
        HillyTerrain: 0.82,
        KentuckyBluegrass: 0.91,
        ClayLoam: 0.85
      },
      regional_expertise: ['Canton', 'NorthCanton']
    }
  },
  {
    id: 'worker_2',
    name: 'Maria Garcia',
    skills: ['Mowing', 'Planting', 'Landscaping', 'WeedControl', 'LandscapeDesign'],
    home_coords: { lat: 40.7900, lng: -81.4500 },
    rating: 4.9,
    hourly_rate: 28,
    active_assignment_ids: [],
    certifications: ['MasterGardener', 'IrrigationSpecialist', 'PesticideApplicator'],
    years_experience: 12,
    availability: 'full_time',
    performance_metrics: {
      efficiency_score: 0.96,
      quality_consistency: 0.94,
      customer_satisfaction: 4.9,
      specialization_factors: {
        DelicateLandscaping: 0.98,
        WeedControl: 0.95,
        Bermuda: 0.92,
        SandyLoam: 0.88
      },
      regional_expertise: ['Massillon', 'PerryTownship']
    }
  },
  {
    id: 'worker_3',
    name: 'David Brown',
    skills: ['Mowing', 'Aeration', 'Seeding', 'TreeTrimming'],
    home_coords: { lat: 40.8200, lng: -81.3600 },
    rating: 4.7,
    hourly_rate: 26,
    active_assignment_ids: [],
    certifications: ['Arborist', 'SafetyTraining'],
    years_experience: 10,
    availability: 'full_time',
    performance_metrics: {
      efficiency_score: 0.89,
      quality_consistency: 0.91,
      customer_satisfaction: 4.7,
      specialization_factors: {
        Aeration: 0.93,
        TreeWork: 0.90,
        CommercialProperties: 0.87
      },
      regional_expertise: ['Canton', 'Alliance']
    }
  },
  {
    id: 'worker_4',
    name: 'Jennifer Wilson',
    skills: ['Mowing', 'Fertilizing', 'PestControl', 'DiseaseManagement'],
    home_coords: { lat: 40.8700, lng: -81.4100 },
    rating: 4.8,
    hourly_rate: 30,
    active_assignment_ids: [],
    certifications: ['CertifiedTurfManager', 'PesticideApplicator', 'IPMSpecialist'],
    years_experience: 15,
    availability: 'full_time',
    performance_metrics: {
      efficiency_score: 0.94,
      quality_consistency: 0.96,
      customer_satisfaction: 4.8,
      specialization_factors: {
        DiseaseControl: 0.97,
        OrganicMethods: 0.93,
        PremiumProperties: 0.95
      },
      regional_expertise: ['NorthCanton', 'Jackson']
    }
  },
  {
    id: 'worker_5',
    name: 'Robert Martinez',
    skills: ['Mowing', 'Edging', 'Mulching', 'Cleanup'],
    home_coords: { lat: 40.7800, lng: -81.5300 },
    rating: 4.5,
    hourly_rate: 22,
    active_assignment_ids: [],
    certifications: ['SafetyTraining'],
    years_experience: 5,
    availability: 'full_time',
    performance_metrics: {
      efficiency_score: 0.85,
      quality_consistency: 0.82,
      customer_satisfaction: 4.5,
      specialization_factors: {
        BasicMowing: 0.88,
        Cleanup: 0.90,
        ResidentialSmall: 0.86
      },
      regional_expertise: ['Massillon']
    }
  },
  {
    id: 'worker_6',
    name: 'Linda Anderson',
    skills: ['Mowing', 'Irrigation', 'WaterManagement', 'Landscaping'],
    home_coords: { lat: 40.8100, lng: -81.3800 },
    rating: 4.9,
    hourly_rate: 29,
    active_assignment_ids: [],
    certifications: ['CertifiedIrrigationContractor', 'WaterConservationSpecialist'],
    years_experience: 11,
    availability: 'full_time',
    performance_metrics: {
      efficiency_score: 0.95,
      quality_consistency: 0.93,
      customer_satisfaction: 4.9,
      specialization_factors: {
        IrrigationSystems: 0.98,
        DroughtManagement: 0.94,
        WaterFeatures: 0.91
      },
      regional_expertise: ['Canton', 'Massillon']
    }
  },
  {
    id: 'worker_7',
    name: 'Thomas Jackson',
    skills: ['Mowing', 'HardscapeInstallation', 'Patios', 'Retaining Walls'],
    home_coords: { lat: 40.9100, lng: -81.1100 },
    rating: 4.6,
    hourly_rate: 32,
    active_assignment_ids: [],
    certifications: ['HardscapeProfessional', 'SafetyTraining'],
    years_experience: 9,
    availability: 'full_time',
    performance_metrics: {
      efficiency_score: 0.88,
      quality_consistency: 0.90,
      customer_satisfaction: 4.6,
      specialization_factors: {
        Hardscaping: 0.96,
        StoneWork: 0.93,
        LargeProjects: 0.89
      },
      regional_expertise: ['Alliance', 'Sebring']
    }
  },
  {
    id: 'worker_8',
    name: 'Patricia Davis',
    skills: ['Mowing', 'Pruning', 'Shrubs', 'FlowerBeds', 'Planting'],
    home_coords: { lat: 40.7950, lng: -81.5100 },
    rating: 4.8,
    hourly_rate: 27,
    active_assignment_ids: [],
    certifications: ['MasterGardener', 'HorticulturistCertified'],
    years_experience: 13,
    availability: 'part_time',
    performance_metrics: {
      efficiency_score: 0.91,
      quality_consistency: 0.95,
      customer_satisfaction: 4.8,
      specialization_factors: {
        Ornamentals: 0.97,
        FlowerGardens: 0.96,
        Pruning: 0.94
      },
      regional_expertise: ['Massillon', 'PerryTownship']
    }
  },
  {
    id: 'worker_9',
    name: 'Michael Thompson',
    skills: ['Mowing', 'SnowRemoval', 'SeasonalCleanup', 'Mulching'],
    home_coords: { lat: 40.8500, lng: -81.4200 },
    rating: 4.4,
    hourly_rate: 24,
    active_assignment_ids: [],
    certifications: ['SafetyTraining', 'SnowPlowOperator'],
    years_experience: 6,
    availability: 'full_time',
    performance_metrics: {
      efficiency_score: 0.83,
      quality_consistency: 0.85,
      customer_satisfaction: 4.4,
      specialization_factors: {
        WinterServices: 0.92,
        FallCleanup: 0.88,
        CommercialSnowRemoval: 0.90
      },
      regional_expertise: ['NorthCanton', 'Canton']
    }
  },
  {
    id: 'worker_10',
    name: 'Sandra White',
    skills: ['Mowing', 'OrganicLawnCare', 'CompostManagement', 'SoilHealth'],
    home_coords: { lat: 40.8300, lng: -81.3500 },
    rating: 4.9,
    hourly_rate: 31,
    active_assignment_ids: [],
    certifications: ['OrganicLandCareProfessional', 'SoilScientist', 'CompostSpecialist'],
    years_experience: 14,
    availability: 'full_time',
    performance_metrics: {
      efficiency_score: 0.93,
      quality_consistency: 0.97,
      customer_satisfaction: 4.9,
      specialization_factors: {
        OrganicMethods: 0.99,
        SoilRemediation: 0.96,
        EcoFriendly: 0.98
      },
      regional_expertise: ['Canton', 'NorthCanton', 'Jackson']
    }
  },
  {
    id: 'worker_11',
    name: 'Christopher Harris',
    skills: ['Mowing', 'Edging', 'EquipmentMaintenance', 'CommercialMowing'],
    home_coords: { lat: 40.7750, lng: -81.5400 },
    rating: 4.6,
    hourly_rate: 23,
    active_assignment_ids: [],
    certifications: ['EquipmentOperator', 'SafetyTraining'],
    years_experience: 7,
    availability: 'full_time',
    performance_metrics: {
      efficiency_score: 0.87,
      quality_consistency: 0.86,
      customer_satisfaction: 4.6,
      specialization_factors: {
        LargeCommercial: 0.91,
        EquipmentSkills: 0.93,
        FastPaced: 0.89
      },
      regional_expertise: ['Massillon']
    }
  },
  {
    id: 'worker_12',
    name: 'Elizabeth Moore',
    skills: ['Mowing', 'ColorDesign', 'Annuals', 'Perennials', 'Landscaping'],
    home_coords: { lat: 40.8650, lng: -81.4150 },
    rating: 4.7,
    hourly_rate: 28,
    active_assignment_ids: [],
    certifications: ['LandscapeDesigner', 'ColorTheoryCertified'],
    years_experience: 10,
    availability: 'part_time',
    performance_metrics: {
      efficiency_score: 0.90,
      quality_consistency: 0.92,
      customer_satisfaction: 4.7,
      specialization_factors: {
        ColorSchemes: 0.95,
        SeasonalDisplays: 0.94,
        DesignConsultation: 0.93
      },
      regional_expertise: ['NorthCanton']
    }
  }
];

// ==================== REALGREEN CRM SIMULATION ====================

class RealGreenCRM {
  constructor() {
    this.customerDatabase = new Map();
    this.serviceTickets = [];
    this.invoices = [];
    this.communications = [];
  }

  // Customer lifecycle management
  createCustomer(customerData) {
    const customer = {
      ...customerData,
      crm_id: `RG${Date.now()}`,
      created_at: new Date().toISOString(),
      lifecycle_stage: 'lead', // lead, prospect, active, at_risk, inactive
      lifetime_value: 0,
      next_service_date: null,
      account_manager: null
    };
    this.customerDatabase.set(customer.id, customer);
    return customer;
  }

  // Service ticket management
  createServiceTicket(customerId, serviceType, priority = 'medium') {
    const ticket = {
      id: `ticket_${uuidv4()}`,
      customer_id: customerId,
      service_type: serviceType,
      status: 'open', // open, scheduled, in_progress, completed, cancelled
      priority: priority, // low, medium, high, urgent
      created_at: new Date().toISOString(),
      scheduled_date: null,
      assigned_worker: null,
      estimated_cost: 0,
      actual_cost: 0
    };
    this.serviceTickets.push(ticket);
    return ticket;
  }

  // Invoice generation
  generateInvoice(customerId, amount, services) {
    const invoice = {
      id: `INV-${Date.now()}`,
      customer_id: customerId,
      amount: amount,
      services: services,
      status: 'pending', // pending, paid, overdue, cancelled
      created_at: new Date().toISOString(),
      due_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      payment_method: null
    };
    this.invoices.push(invoice);
    return invoice;
  }

  // Communication tracking
  logCommunication(customerId, type, content) {
    const comm = {
      id: `comm_${uuidv4()}`,
      customer_id: customerId,
      type: type, // email, phone, sms, in_person, ai_chat
      content: content,
      timestamp: new Date().toISOString(),
      sentiment: 'neutral' // positive, neutral, negative
    };
    this.communications.push(comm);
    return comm;
  }

  getCustomerProfile(customerId) {
    return this.customerDatabase.get(customerId);
  }

  getCustomerServiceHistory(customerId) {
    return this.serviceTickets.filter(t => t.customer_id === customerId);
  }

  getCustomerInvoices(customerId) {
    return this.invoices.filter(i => i.customer_id === customerId);
  }
}

const realGreenCRM = new RealGreenCRM();

// Generate 20 diverse customers across Stark County
const customers = [
  {
    id: 'cust_1',
    name: 'Sarah Johnson',
    email: 'sarah.johnson@email.com',
    phone: '+1-330-555-0123',
    address: '123 Main St, Canton, OH 44702',
    coordinates: { lat: 40.7989, lng: -81.3784 },
    customer_tier: 'premium',
    service_history: [
      { job_id: 'site_1', date: '2024-01-15', service_type: 'FullLawnCare', worker_assigned: 'John Smith', rating: 4.8, feedback: 'Excellent work on the edging!' }
    ],
    preferences: { communication: 'email', billing: 'monthly', organic_only: true },
    current_issues: ['BrownPatches', 'WeedInfestation'],
    property_type: 'residential',
    lot_size: 0.5,
    annual_contract_value: 2400
  },
  {
    id: 'cust_2',
    name: 'Michael Chen',
    email: 'mchen@techcorp.com',
    phone: '+1-330-555-0234',
    address: '456 Oak Ave, Massillon, OH 44646',
    coordinates: { lat: 40.7967, lng: -81.5215 },
    customer_tier: 'standard',
    service_history: [
      { job_id: 'site_2', date: '2024-02-20', service_type: 'Mowing', worker_assigned: 'Maria Garcia', rating: 4.9, feedback: 'Always on time!' }
    ],
    preferences: { communication: 'sms', billing: 'per_service', organic_only: false },
    current_issues: ['CrabgrassControl'],
    property_type: 'residential',
    lot_size: 0.33,
    annual_contract_value: 1200
  },
  {
    id: 'cust_3',
    name: 'Jennifer Martinez',
    email: 'jmartinez@email.com',
    phone: '+1-330-555-0345',
    address: '789 Maple Dr, North Canton, OH 44720',
    coordinates: { lat: 40.8756, lng: -81.4023 },
    customer_tier: 'premium',
    service_history: [],
    preferences: { communication: 'email', billing: 'monthly', organic_only: true },
    current_issues: ['LawnRenovation', 'ThatchBuildup'],
    property_type: 'residential',
    lot_size: 0.75,
    annual_contract_value: 3600
  },
  {
    id: 'cust_4',
    name: 'Robert Williams',
    email: 'rwilliams@email.com',
    phone: '+1-330-555-0456',
    address: '234 Pine St, Alliance, OH 44601',
    coordinates: { lat: 40.9153, lng: -81.1059 },
    customer_tier: 'basic',
    service_history: [
      { job_id: 'site_3', date: '2024-03-10', service_type: 'Mowing', worker_assigned: 'David Brown', rating: 4.2, feedback: 'Good service' }
    ],
    preferences: { communication: 'phone', billing: 'per_service', organic_only: false },
    current_issues: [],
    property_type: 'residential',
    lot_size: 0.25,
    annual_contract_value: 800
  },
  {
    id: 'cust_5',
    name: 'Emily Davis',
    email: 'edavis@greenvalley.com',
    phone: '+1-330-555-0567',
    address: '567 Elm Blvd, Canton, OH 44708',
    coordinates: { lat: 40.8123, lng: -81.3912 },
    customer_tier: 'premium',
    service_history: [
      { job_id: 'site_4', date: '2024-01-25', service_type: 'FullLawnCare', worker_assigned: 'Maria Garcia', rating: 5.0, feedback: 'Outstanding!' }
    ],
    preferences: { communication: 'email', billing: 'annual', organic_only: true },
    current_issues: ['DiseaseControl'],
    property_type: 'residential',
    lot_size: 1.2,
    annual_contract_value: 4800
  },
  {
    id: 'cust_6',
    name: 'David Thompson',
    email: 'dthompson@email.com',
    phone: '+1-330-555-0678',
    address: '890 Cherry Ln, Massillon, OH 44647',
    coordinates: { lat: 40.7834, lng: -81.5387 },
    customer_tier: 'standard',
    service_history: [],
    preferences: { communication: 'sms', billing: 'monthly', organic_only: false },
    current_issues: ['BareSpots', 'PoorDrainage'],
    property_type: 'residential',
    lot_size: 0.4,
    annual_contract_value: 1800
  },
  {
    id: 'cust_7',
    name: 'Lisa Anderson',
    email: 'landerson@email.com',
    phone: '+1-330-555-0789',
    address: '123 Walnut Ave, Canton, OH 44705',
    coordinates: { lat: 40.7856, lng: -81.3567 },
    customer_tier: 'basic',
    service_history: [
      { job_id: 'site_5', date: '2024-04-05', service_type: 'Aeration', worker_assigned: 'John Smith', rating: 4.6, feedback: 'Great improvement' }
    ],
    preferences: { communication: 'email', billing: 'per_service', organic_only: false },
    current_issues: ['CompactedSoil'],
    property_type: 'residential',
    lot_size: 0.3,
    annual_contract_value: 600
  },
  {
    id: 'cust_8',
    name: 'James Wilson',
    email: 'jwilson@commercialplaza.com',
    phone: '+1-330-555-0890',
    address: '456 Business Pkwy, North Canton, OH 44720',
    coordinates: { lat: 40.8623, lng: -81.4156 },
    customer_tier: 'commercial',
    service_history: [
      { job_id: 'site_6', date: '2024-02-14', service_type: 'CommercialMaintenance', worker_assigned: 'David Brown', rating: 4.7, feedback: 'Professional service' }
    ],
    preferences: { communication: 'email', billing: 'monthly', organic_only: false },
    current_issues: ['HighTrafficAreas'],
    property_type: 'commercial',
    lot_size: 2.5,
    annual_contract_value: 12000
  },
  {
    id: 'cust_9',
    name: 'Patricia Moore',
    email: 'pmoore@email.com',
    phone: '+1-330-555-0901',
    address: '789 Sunset Dr, Massillon, OH 44646',
    coordinates: { lat: 40.7701, lng: -81.5123 },
    customer_tier: 'premium',
    service_history: [],
    preferences: { communication: 'phone', billing: 'monthly', organic_only: true },
    current_issues: ['MossGrowth', 'ShadeIssues'],
    property_type: 'residential',
    lot_size: 0.6,
    annual_contract_value: 2800
  },
  {
    id: 'cust_10',
    name: 'Christopher Taylor',
    email: 'ctaylor@email.com',
    phone: '+1-330-555-1012',
    address: '321 River Rd, Canton, OH 44706',
    coordinates: { lat: 40.8234, lng: -81.3456 },
    customer_tier: 'standard',
    service_history: [
      { job_id: 'site_7', date: '2024-03-20', service_type: 'Fertilization', worker_assigned: 'Maria Garcia', rating: 4.8, feedback: 'Lawn looks amazing!' }
    ],
    preferences: { communication: 'sms', billing: 'per_service', organic_only: false },
    current_issues: ['NutrientDeficiency'],
    property_type: 'residential',
    lot_size: 0.45,
    annual_contract_value: 1500
  },
  {
    id: 'cust_11',
    name: 'Nancy Jackson',
    email: 'njackson@email.com',
    phone: '+1-330-555-1123',
    address: '654 Hill St, Alliance, OH 44601',
    coordinates: { lat: 40.9234, lng: -81.1234 },
    customer_tier: 'basic',
    service_history: [],
    preferences: { communication: 'email', billing: 'per_service', organic_only: false },
    current_issues: ['OvergrownLawn'],
    property_type: 'residential',
    lot_size: 0.35,
    annual_contract_value: 700
  },
  {
    id: 'cust_12',
    name: 'Daniel White',
    email: 'dwhite@industrialpark.com',
    phone: '+1-330-555-1234',
    address: '987 Industrial Dr, Canton, OH 44707',
    coordinates: { lat: 40.7923, lng: -81.3623 },
    customer_tier: 'commercial',
    service_history: [
      { job_id: 'site_8', date: '2024-01-30', service_type: 'CommercialMaintenance', worker_assigned: 'David Brown', rating: 4.5, feedback: 'Reliable service' }
    ],
    preferences: { communication: 'email', billing: 'monthly', organic_only: false },
    current_issues: ['LargeAreaMaintenance'],
    property_type: 'commercial',
    lot_size: 5.0,
    annual_contract_value: 18000
  },
  {
    id: 'cust_13',
    name: 'Karen Harris',
    email: 'kharris@email.com',
    phone: '+1-330-555-1345',
    address: '147 Garden Ln, Massillon, OH 44646',
    coordinates: { lat: 40.7889, lng: -81.5289 },
    customer_tier: 'premium',
    service_history: [
      { job_id: 'site_9', date: '2024-02-28', service_type: 'LandscapeDesign', worker_assigned: 'Maria Garcia', rating: 5.0, feedback: 'Beautiful work!' }
    ],
    preferences: { communication: 'email', billing: 'monthly', organic_only: true },
    current_issues: ['LandscapingNeeds'],
    property_type: 'residential',
    lot_size: 0.8,
    annual_contract_value: 5200
  },
  {
    id: 'cust_14',
    name: 'Steven Martin',
    email: 'smartin@email.com',
    phone: '+1-330-555-1456',
    address: '258 Forest Ave, North Canton, OH 44720',
    coordinates: { lat: 40.8689, lng: -81.4267 },
    customer_tier: 'standard',
    service_history: [],
    preferences: { communication: 'phone', billing: 'per_service', organic_only: false },
    current_issues: ['TreeDebris'],
    property_type: 'residential',
    lot_size: 0.55,
    annual_contract_value: 1600
  },
  {
    id: 'cust_15',
    name: 'Betty Thompson',
    email: 'bthompson@email.com',
    phone: '+1-330-555-1567',
    address: '369 Meadow Rd, Canton, OH 44709',
    coordinates: { lat: 40.8156, lng: -81.4012 },
    customer_tier: 'premium',
    service_history: [
      { job_id: 'site_10', date: '2024-03-15', service_type: 'FullLawnCare', worker_assigned: 'John Smith', rating: 4.9, feedback: 'Thorough and professional' }
    ],
    preferences: { communication: 'email', billing: 'annual', organic_only: true },
    current_issues: ['GrubControl'],
    property_type: 'residential',
    lot_size: 0.9,
    annual_contract_value: 3900
  },
  {
    id: 'cust_16',
    name: 'Kevin Garcia',
    email: 'kgarcia@email.com',
    phone: '+1-330-555-1678',
    address: '741 Valley View Dr, Massillon, OH 44647',
    coordinates: { lat: 40.7756, lng: -81.5456 },
    customer_tier: 'basic',
    service_history: [],
    preferences: { communication: 'sms', billing: 'per_service', organic_only: false },
    current_issues: ['BasicMowing'],
    property_type: 'residential',
    lot_size: 0.28,
    annual_contract_value: 550
  },
  {
    id: 'cust_17',
    name: 'Sandra Rodriguez',
    email: 'srodriguez@email.com',
    phone: '+1-330-555-1789',
    address: '852 Park Ave, Alliance, OH 44601',
    coordinates: { lat: 40.9067, lng: -81.1167 },
    customer_tier: 'standard',
    service_history: [
      { job_id: 'site_11', date: '2024-04-10', service_type: 'WeedControl', worker_assigned: 'Maria Garcia', rating: 4.7, feedback: 'Effective treatment' }
    ],
    preferences: { communication: 'email', billing: 'monthly', organic_only: false },
    current_issues: ['DandelionInvasion'],
    property_type: 'residential',
    lot_size: 0.42,
    annual_contract_value: 1400
  },
  {
    id: 'cust_18',
    name: 'Paul Martinez',
    email: 'pmartinez@shoppingcenter.com',
    phone: '+1-330-555-1890',
    address: '963 Commerce St, Canton, OH 44710',
    coordinates: { lat: 40.8045, lng: -81.3734 },
    customer_tier: 'commercial',
    service_history: [
      { job_id: 'site_12', date: '2024-02-05', service_type: 'CommercialMaintenance', worker_assigned: 'David Brown', rating: 4.6, feedback: 'Good value' }
    ],
    preferences: { communication: 'email', billing: 'monthly', organic_only: false },
    current_issues: ['ParkingLotLandscaping'],
    property_type: 'commercial',
    lot_size: 3.2,
    annual_contract_value: 15000
  },
  {
    id: 'cust_19',
    name: 'Dorothy Lee',
    email: 'dlee@email.com',
    phone: '+1-330-555-1901',
    address: '159 Brookside Dr, North Canton, OH 44720',
    coordinates: { lat: 40.8534, lng: -81.4089 },
    customer_tier: 'premium',
    service_history: [],
    preferences: { communication: 'phone', billing: 'monthly', organic_only: true },
    current_issues: ['SlopeErosion'],
    property_type: 'residential',
    lot_size: 0.65,
    annual_contract_value: 3200
  },
  {
    id: 'cust_20',
    name: 'Mark Anderson',
    email: 'manderson@email.com',
    phone: '+1-330-555-2012',
    address: '753 Countryside Ln, Massillon, OH 44646',
    coordinates: { lat: 40.7812, lng: -81.5178 },
    customer_tier: 'standard',
    service_history: [
      { job_id: 'site_13', date: '2024-03-25', service_type: 'SpringCleanup', worker_assigned: 'John Smith', rating: 4.8, feedback: 'Yard looks great!' }
    ],
    preferences: { communication: 'sms', billing: 'per_service', organic_only: false },
    current_issues: ['FallLeafRemoval'],
    property_type: 'residential',
    lot_size: 0.48,
    annual_contract_value: 1300
  }
];

// Initialize all customers in RealGreen CRM
customers.forEach(customer => {
  realGreenCRM.createCustomer(customer);
});

const assignments = [];
const customerInquiries = [];

// ==================== HELPER FUNCTIONS ====================

function calculateAssignmentScore(worker, workSite) {
  const skillMatch = calculateSkillMatch(worker.skills, workSite.preferred_skills);
  const distance = calculateDistance(worker.home_coords, workSite.coords);
  const distanceScore = Math.max(0, 1 - (distance / 20));
  const availabilityScore = worker.active_assignment_ids.length === 0 ? 1 : 
                          worker.active_assignment_ids.length <= 2 ? 0.7 : 0.3;
  const historicalScore = worker.rating / 5;

  return (skillMatch * 0.4 + distanceScore * 0.3 + availabilityScore * 0.2 + historicalScore * 0.1);
}

function calculateSkillMatch(workerSkills, siteSkills) {
  if (!siteSkills.length) return 0.5;
  const matching = siteSkills.filter(skill => workerSkills.includes(skill));
  return matching.length / siteSkills.length;
}

function calculateDistance(coord1, coord2) {
  const R = 6371;
  const dLat = (coord2.lat - coord1.lat) * Math.PI / 180;
  const dLon = (coord2.lng - coord1.lng) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(coord1.lat * Math.PI / 180) * Math.cos(coord2.lat * Math.PI / 180) * 
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function getRegionFromAddress(address) {
  if (address.includes('Canton')) return 'Canton';
  if (address.includes('Massillon')) return 'Massillon';
  return 'StarkCounty';
}

async function getKGInsightsForSite(site) {
  const region = getRegionFromAddress(site.address);
  const regionalData = kg.data.regions[region] || {};
  const soilData = kg.data.soilTypes[site.regional_factors?.[0]] || {};
  const grassData = kg.data.grassTypes[site.grass_type] || {};
  
  return {
    region: region,
    climate_zone: regionalData.climateZone,
    soil_analysis: `${site.regional_factors?.[0]} - ${soilData.drainage} drainage, pH ${soilData.pH}`,
    grass_requirements: `${site.grass_type} - ${grassData.maintenance} maintenance, ${grassData.droughtTolerance} drought tolerance`,
    seasonal_considerations: 'Spring growth period - optimal for aeration and overseeding',
    common_weeds: regionalData.commonWeeds?.join(', ') || 'Various',
    mowing_height: grassData.idealMowingHeight
  };
}

// ==================== REALGREEN CRM API ENDPOINTS ====================

// Get customer CRM profile
app.get('/api/crm/customer/:customerId', (req, res) => {
  try {
    const { customerId } = req.params;
    const profile = realGreenCRM.getCustomerProfile(customerId);
    const serviceHistory = realGreenCRM.getCustomerServiceHistory(customerId);
    const invoices = realGreenCRM.getCustomerInvoices(customerId);
    const communications = realGreenCRM.communications.filter(c => c.customer_id === customerId);
    
    if (!profile) {
      return res.json({ success: false, error: 'Customer not found' });
    }
    
    res.json({
      success: true,
      profile,
      service_history: serviceHistory,
      invoices,
      communications: communications.slice(-10),
      lifetime_stats: {
        total_services: serviceHistory.length,
        total_invoiced: invoices.reduce((sum, inv) => sum + inv.amount, 0),
        avg_rating: profile.service_history.reduce((sum, s) => sum + s.rating, 0) / (profile.service_history.length || 1)
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Create service ticket
app.post('/api/crm/ticket', (req, res) => {
  try {
    const { customerId, serviceType, priority } = req.body;
    
    const customer = customers.find(c => c.id === customerId);
    if (!customer) {
      return res.json({ success: false, error: 'Customer not found' });
    }
    
    const ticket = realGreenCRM.createServiceTicket(customerId, serviceType, priority);
    
    // Log in CRM
    realGreenCRM.logCommunication(customerId, 'ticket_created', `Service ticket created: ${serviceType}`);
    
    io.emit('ticket_created', ticket);
    
    res.json({
      success: true,
      ticket,
      message: 'Service ticket created successfully'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Generate invoice
app.post('/api/crm/invoice', (req, res) => {
  try {
    const { customerId, amount, services } = req.body;
    
    const customer = customers.find(c => c.id === customerId);
    if (!customer) {
      return res.json({ success: false, error: 'Customer not found' });
    }
    
    const invoice = realGreenCRM.generateInvoice(customerId, amount, services);
    
    // Log in CRM
    realGreenCRM.logCommunication(customerId, 'invoice_generated', `Invoice ${invoice.id} for ${amount}`);
    
    io.emit('invoice_created', invoice);
    
    res.json({
      success: true,
      invoice,
      message: 'Invoice generated successfully'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get all service tickets
app.get('/api/crm/tickets', (req, res) => {
  try {
    const { status, priority } = req.query;
    
    let tickets = realGreenCRM.serviceTickets;
    
    if (status) {
      tickets = tickets.filter(t => t.status === status);
    }
    
    if (priority) {
      tickets = tickets.filter(t => t.priority === priority);
    }
    
    res.json({
      success: true,
      tickets,
      count: tickets.length,
      by_status: {
        open: realGreenCRM.serviceTickets.filter(t => t.status === 'open').length,
        scheduled: realGreenCRM.serviceTickets.filter(t => t.status === 'scheduled').length,
        in_progress: realGreenCRM.serviceTickets.filter(t => t.status === 'in_progress').length,
        completed: realGreenCRM.serviceTickets.filter(t => t.status === 'completed').length
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get customer lifecycle analytics
app.get('/api/crm/analytics/lifecycle', (req, res) => {
  try {
    const lifecycleData = {
      lead: 0,
      prospect: 0,
      active: 0,
      at_risk: 0,
      inactive: 0
    };
    
    customers.forEach(customer => {
      const profile = realGreenCRM.getCustomerProfile(customer.id);
      if (profile && profile.lifecycle_stage) {
        lifecycleData[profile.lifecycle_stage]++;
      }
    });
    
    const totalRevenue = customers.reduce((sum, c) => sum + (c.annual_contract_value || 0), 0);
    const avgContractValue = totalRevenue / customers.length;
    
    res.json({
      success: true,
      lifecycle: lifecycleData,
      revenue: {
        total_annual: totalRevenue,
        average_contract: avgContractValue,
        by_tier: {
          premium: customers.filter(c => c.customer_tier === 'premium').reduce((s, c) => s + c.annual_contract_value, 0),
          standard: customers.filter(c => c.customer_tier === 'standard').reduce((s, c) => s + c.annual_contract_value, 0),
          basic: customers.filter(c => c.customer_tier === 'basic').reduce((s, c) => s + c.annual_contract_value, 0),
          commercial: customers.filter(c => c.customer_tier === 'commercial').reduce((s, c) => s + c.annual_contract_value, 0)
        }
      },
      customer_distribution: {
        residential: customers.filter(c => c.property_type === 'residential').length,
        commercial: customers.filter(c => c.property_type === 'commercial').length
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get worker performance analytics
app.get('/api/crm/analytics/workers', (req, res) => {
  try {
    const workerStats = workers.map(worker => ({
      id: worker.id,
      name: worker.name,
      rating: worker.rating,
      efficiency: worker.performance_metrics.efficiency_score,
      quality: worker.performance_metrics.quality_consistency,
      satisfaction: worker.performance_metrics.customer_satisfaction,
      active_jobs: worker.active_assignment_ids.length,
      specializations: Object.keys(worker.performance_metrics.specialization_factors || {}),
      availability: worker.availability,
      years_experience: worker.years_experience
    }));
    
    res.json({
      success: true,
      workers: workerStats.sort((a, b) => b.rating - a.rating),
      summary: {
        total_workers: workers.length,
        full_time: workers.filter(w => w.availability === 'full_time').length,
        part_time: workers.filter(w => w.availability === 'part_time').length,
        avg_rating: workers.reduce((sum, w) => sum + w.rating, 0) / workers.length,
        avg_experience: workers.reduce((sum, w) => sum + w.years_experience, 0) / workers.length
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Enhanced AI chat with CRM integration
app.post('/api/crm/chat', async (req, res) => {
  try {
    const { customerId, message } = req.body;
    
    const customer = customers.find(c => c.id === customerId);
    if (!customer) {
      return res.json({ success: false, error: 'Customer not found' });
    }

    // Get full CRM context
    const serviceHistory = realGreenCRM.getCustomerServiceHistory(customerId);
    const invoices = realGreenCRM.getCustomerInvoices(customerId);
    const recentComms = realGreenCRM.communications
      .filter(c => c.customer_id === customerId)
      .slice(-5);

    const context = {
      customer: customer,
      crm_profile: realGreenCRM.getCustomerProfile(customerId),
      service_tickets: serviceHistory,
      invoices: invoices,
      recent_communications: recentComms,
      regional_insights: kg.findRegionalExpertise(getRegionFromAddress(customer.address)),
      seasonal_recommendations: kg.getOptimalSeasonalActivities('Spring')
    };

    const intent = await aiAgent.analyzeCustomerIntent(message, context);
    const history = aiAgent.getConversationHistory(customerId);
    const response = await aiAgent.generateCustomerResponse(message, context, intent, history);

    if (!response.success) {
      throw new Error(response.error);
    }

    aiAgent.addToHistory(customerId, 'user', message);
    aiAgent.addToHistory(customerId, 'assistant', response.content);

    // Log in RealGreen CRM
    realGreenCRM.logCommunication(customerId, 'ai_chat', message);

    const inquiry = {
      id: uuidv4(),
      customerId,
      timestamp: new Date().toISOString(),
      question: message,
      response: response.content,
      intent: intent.intent,
      confidence: intent.confidence
    };
    customerInquiries.push(inquiry);

    res.json({
      success: true,
      response: response.content,
      intent: intent,
      usage: response.usage,
      model: response.model,
      crm_logged: true
    });
    
  } catch (error) {
    console.error('Mistral Chat Error:', error);
    res.json({ 
      success: false, 
      error: error.message,
      fallback: "I apologize, but I'm having trouble connecting right now. Please try again or call our office at 1-800-LAWN-CARE."
    });
  }
});

// ==================== ORIGINAL API ENDPOINTS ====================

app.get('/api/sites', (req, res) => {
  res.json({ success: true, data: workSites });
});

app.get('/api/workers', (req, res) => {
  res.json({ success: true, data: workers });
});

app.get('/api/customers', (req, res) => {
  res.json({ success: true, data: customers });
});

app.post('/api/sites', (req, res) => {
  try {
    const { address, lat, lng, difficulty, skills } = req.body;
    
    const newSite = {
      id: `site_${uuidv4()}`,
      address,
      coords: { lat: parseFloat(lat), lng: parseFloat(lng) },
      difficulty_score: parseFloat(difficulty),
      status: 'open',
      preferred_skills: skills || ['Mowing'],
      estimated_hours: Math.round(difficulty * 4) + 1,
      property_size: ['small', 'medium', 'large'][Math.floor(Math.random() * 3)],
      terrain_type: ['flat', 'gently_sloping', 'hilly'][Math.floor(Math.random() * 3)],
      grass_type: ['KentuckyBluegrass', 'Bermuda', 'Fescue'][Math.floor(Math.random() * 3)],
      regional_factors: ['ClayLoam', 'SandyLoam'][Math.floor(Math.random() * 2)],
      historical_data: {
        avg_completion_time: parseFloat(difficulty) * 3 + 1,
        cost_overruns: parseFloat(difficulty) * 0.1,
        customer_rating: 4.5 + (Math.random() * 0.5)
      }
    };
    
    workSites.push(newSite);
    io.emit('site_added', newSite);
    res.json({ success: true, data: newSite });
    
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/assign', (req, res) => {
  try {
    const { workerId, siteId } = req.body;
    
    const site = workSites.find(s => s.id === siteId);
    const worker = workers.find(w => w.id === workerId);
    
    if (!site || !worker) {
      return res.json({ success: false, error: 'Site or worker not found' });
    }
    
    site.status = 'assigned';
    worker.active_assignment_ids.push(siteId);
    
    const assignment = {
      id: `assign_${uuidv4()}`,
      workerId,
      siteId,
      assignedAt: new Date().toISOString(),
      status: 'scheduled'
    };
    assignments.push(assignment);
    
    io.emit('assignment_created', assignment);
    io.emit('site_updated', site);
    io.emit('worker_updated', worker);
    
    res.json({ 
      success: true, 
      message: `Assigned ${worker.name} to ${site.address}`,
      data: assignment 
    });
    
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== MISTRAL AI ENDPOINTS ====================

app.post('/api/crm/chat', async (req, res) => {
  try {
    const { customerId, message } = req.body;
    
    const customer = customers.find(c => c.id === customerId);
    if (!customer) {
      return res.json({ success: false, error: 'Customer not found' });
    }

    const context = {
      customer: customer,
      regional_insights: kg.findRegionalExpertise(getRegionFromAddress(customer.address)),
      seasonal_recommendations: kg.getOptimalSeasonalActivities('Spring')
    };

    const intent = await aiAgent.analyzeCustomerIntent(message, context);
    const history = aiAgent.getConversationHistory(customerId);
    const response = await aiAgent.generateCustomerResponse(message, context, intent, history);

    if (!response.success) {
      throw new Error(response.error);
    }

    aiAgent.addToHistory(customerId, 'user', message);
    aiAgent.addToHistory(customerId, 'assistant', response.content);

    const inquiry = {
      id: uuidv4(),
      customerId,
      timestamp: new Date().toISOString(),
      question: message,
      response: response.content,
      intent: intent.intent,
      confidence: intent.confidence
    };
    customerInquiries.push(inquiry);

    res.json({
      success: true,
      response: response.content,
      intent: intent,
      usage: response.usage,
      model: response.model
    });
    
  } catch (error) {
    console.error('Mistral Chat Error:', error);
    res.json({ 
      success: false, 
      error: error.message,
      fallback: "I apologize, but I'm having trouble connecting right now. Please try again or call our office at 1-800-LAWN-CARE."
    });
  }
});

app.get('/api/ai/recommend/:siteId', async (req, res) => {
  try {
    const { siteId } = req.params;
    const site = workSites.find(s => s.id === siteId);
    
    if (!site) {
      return res.json({ success: false, error: 'Site not found' });
    }

    const kgInsights = await getKGInsightsForSite(site);
    const aiRecommendation = await aiAgent.recommendWorker(site, workers, kgInsights);

    const scores = workers.map(worker => ({
      worker,
      score: calculateAssignmentScore(worker, site)
    })).sort((a, b) => b.score - a.score);

    res.json({
      success: true,
      ai_recommendation: aiRecommendation,
      traditional_scores: scores,
      knowledge_graph_insights: kgInsights
    });

  } catch (error) {
    console.error('AI Recommendation Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/ai/care-plan', async (req, res) => {
  try {
    const { customerId } = req.body;
    
    const customer = customers.find(c => c.id === customerId);
    if (!customer) {
      return res.json({ success: false, error: 'Customer not found' });
    }

    const region = getRegionFromAddress(customer.address);
    const regionalData = {
      region: kg.data.regions[region],
      seasonal: kg.data.seasons.Spring,
      soil: kg.data.soilTypes['ClayLoam']
    };

    const plan = await aiAgent.generateLawnCarePlan(customer, regionalData);

    if (!plan.success) {
      throw new Error(plan.error);
    }

    res.json({
      success: true,
      plan: plan.content,
      customer: customer.name,
      generated_at: new Date().toISOString(),
      usage: plan.usage
    });

  } catch (error) {
    console.error('Care Plan Generation Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/crm/clear-history/:customerId', (req, res) => {
  const { customerId } = req.params;
  aiAgent.clearHistory(customerId);
  res.json({ success: true, message: 'Conversation history cleared' });
});

app.post('/api/ai/batch-analyze', async (req, res) => {
  try {
    const { messages } = req.body;
    
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.json({ success: false, error: 'Messages array required' });
    }

    const results = await Promise.all(
      messages.map(async (msg) => {
        const intent = await aiAgent.analyzeCustomerIntent(msg, { customer: {} });
        return {
          message: msg,
          intent: intent.intent,
          confidence: intent.confidence,
          entities: intent.entities
        };
      })
    );

    res.json({
      success: true,
      analyzed: results.length,
      results: results
    });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/ai/health', async (req, res) => {
  try {
    const testResult = await aiAgent.chat([
      { role: 'user', content: 'Hello, please respond with OK if you are working.' }
    ], { max_tokens: 10 });

    res.json({
      success: true,
      ai_status: testResult.success ? 'operational' : 'error',
      model: testResult.model,
      api_key_configured: MISTRAL_API_KEY !== 'your-mistral-api-key-here',
      response: testResult.content
    });
  } catch (error) {
    res.json({
      success: false,
      ai_status: 'error',
      error: error.message,
      api_key_configured: MISTRAL_API_KEY !== 'your-mistral-api-key-here'
    });
  }
});

// ==================== KNOWLEDGE GRAPH ENDPOINTS ====================

app.get('/api/kg/query', async (req, res) => {
  try {
    const { query } = req.query;
    
    if (!query) {
      return res.json({ success: false, error: 'Query parameter required' });
    }

    const results = kg.query(query);
    
    res.json({
      success: true,
      query,
      results,
      count: results.length
    });
    
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/kg/regional/:region', async (req, res) => {
  try {
    const { region } = req.params;
    
    const regionalData = kg.findRegionalExpertise(region);
    const seasonalActivities = kg.getOptimalSeasonalActivities('Spring');
    
    res.json({
      success: true,
      region,
      regional_insights: regionalData,
      seasonal_recommendations: seasonalActivities,
      region_data: kg.data.regions[region]
    });
    
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/kg/skills/:skill', async (req, res) => {
  try {
    const { skill } = req.params;
    
    const skillRequirements = kg.getSkillRequirements(skill);
    const certifiedWorkers = workers.filter(worker => 
      worker.skills.includes(skill)
    );
    
    res.json({
      success: true,
      skill,
      requirements: skillRequirements,
      certified_workers: certifiedWorkers.map(w => ({
        id: w.id,
        name: w.name,
        rating: w.rating,
        proficiency: w.performance_metrics.specialization_factors[skill] || 0.7
      })),
      skill_data: kg.data.skills[skill]
    });
    
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== ANALYTICS ENDPOINTS ====================

app.get('/api/analytics/inquiries', (req, res) => {
  try {
    const inquiryStats = {
      total: customerInquiries.length,
      by_intent: {},
      avg_confidence: 0,
      recent: customerInquiries.slice(-10).reverse()
    };

    customerInquiries.forEach(inq => {
      if (inq.intent) {
        inquiryStats.by_intent[inq.intent] = (inquiryStats.by_intent[inq.intent] || 0) + 1;
        inquiryStats.avg_confidence += inq.confidence || 0;
      }
    });

    if (customerInquiries.length > 0) {
      inquiryStats.avg_confidence /= customerInquiries.length;
    }

    res.json({ success: true, data: inquiryStats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/status', (req, res) => {
  res.json({
    success: true,
    message: 'LawnCare AI-Powered System with RealGreen CRM',
    stats: {
      sites: workSites.length,
      workers: workers.length,
      customers: customers.length,
      assignments: assignments.length,
      inquiries: customerInquiries.length,
      kg_entities: Object.keys(kg.data).reduce((acc, key) => acc + Object.keys(kg.data[key]).length, 0)
    },
    crm_stats: {
      service_tickets: realGreenCRM.serviceTickets.length,
      invoices: realGreenCRM.invoices.length,
      communications: realGreenCRM.communications.length,
      total_revenue: customers.reduce((sum, c) => sum + (c.annual_contract_value || 0), 0)
    },
    ai_agent: {
      enabled: MISTRAL_API_KEY !== 'your-mistral-api-key-here',
      model: MISTRAL_MODEL,
      active_conversations: aiAgent.conversationHistory.size
    },
    timestamp: new Date().toISOString()
  });
});

app.post('/api/test/ai-chat', async (req, res) => {
  try {
    const { message } = req.body;
    
    if (!message) {
      return res.json({ success: false, error: 'Message required' });
    }

    const result = await aiAgent.chat([
      { role: 'system', content: 'You are a helpful lawn care assistant.' },
      { role: 'user', content: message }
    ]);

    res.json({
      success: result.success,
      response: result.content,
      usage: result.usage,
      model: result.model
    });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== WEBSOCKET EVENTS ====================

io.on('connection', (socket) => {
  console.log(`✅ Client connected: ${socket.id}`);

  socket.emit('welcome', {
    message: 'Connected to LawnCare AI System',
    features: ['Real-time updates', 'AI-powered chat', 'Knowledge graph queries']
  });

  socket.on('ai_chat', async (data) => {
    try {
      const { customerId, message } = data;
      
      const customer = customers.find(c => c.id === customerId);
      if (!customer) {
        socket.emit('ai_response', { 
          success: false, 
          error: 'Customer not found' 
        });
        return;
      }

      const context = {
        customer: customer,
        regional_insights: kg.findRegionalExpertise(getRegionFromAddress(customer.address)),
        seasonal_recommendations: kg.getOptimalSeasonalActivities('Spring')
      };

      const intent = await aiAgent.analyzeCustomerIntent(message, context);
      const history = aiAgent.getConversationHistory(customerId);
      const response = await aiAgent.generateCustomerResponse(message, context, intent, history);

      if (response.success) {
        aiAgent.addToHistory(customerId, 'user', message);
        aiAgent.addToHistory(customerId, 'assistant', response.content);

        socket.emit('ai_response', {
          success: true,
          response: response.content,
          intent: intent,
          timestamp: new Date().toISOString()
        });

        socket.broadcast.emit('new_inquiry', {
          customerId,
          customerName: customer.name,
          message,
          intent: intent.intent,
          timestamp: new Date().toISOString()
        });
      } else {
        socket.emit('ai_response', {
          success: false,
          error: response.error
        });
      }

    } catch (error) {
      console.error('WebSocket AI Chat Error:', error);
      socket.emit('ai_response', {
        success: false,
        error: error.message
      });
    }
  });

  socket.on('request_recommendation', async (data) => {
    try {
      const { siteId } = data;
      const site = workSites.find(s => s.id === siteId);
      
      if (!site) {
        socket.emit('recommendation_result', { 
          success: false, 
          error: 'Site not found' 
        });
        return;
      }

      const kgInsights = await getKGInsightsForSite(site);
      const aiRecommendation = await aiAgent.recommendWorker(site, workers, kgInsights);

      socket.emit('recommendation_result', {
        success: true,
        recommendation: aiRecommendation,
        insights: kgInsights,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      socket.emit('recommendation_result', {
        success: false,
        error: error.message
      });
    }
  });

  socket.on('disconnect', () => {
    console.log(`❌ Client disconnected: ${socket.id}`);
  });
});

// ==================== SERVER STARTUP ====================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`🚀 LawnCare AI-Powered System with RealGreen CRM Integration`);
  console.log(`${'='.repeat(70)}`);
  console.log(`\n📡 Server: http://localhost:${PORT}`);
  console.log(`🧠 Knowledge Graph: ${Object.keys(kg.data).length} entity types loaded`);
  console.log(`🤖 Mistral AI Agent: ${MISTRAL_API_KEY !== 'your-mistral-api-key-here' ? '✅ ENABLED' : '❌ DISABLED (Configure API key)'}`);
  console.log(`   Model: ${MISTRAL_MODEL}`);
  console.log(`\n📊 Current Data:`);
  console.log(`   - Sites: ${workSites.length}`);
  console.log(`   - Workers: ${workers.length} (${workers.filter(w => w.availability === 'full_time').length} full-time)`);
  console.log(`   - Customers: ${customers.length}`);
  console.log(`   - Total Annual Revenue: ${customers.reduce((s, c) => s + c.annual_contract_value, 0).toLocaleString()}`);
  console.log(`\n🏢 RealGreen CRM:`);
  console.log(`   - Customer Database: ${realGreenCRM.customerDatabase.size} profiles`);
  console.log(`   - Service Tickets: ${realGreenCRM.serviceTickets.length}`);
  console.log(`   - Invoices: ${realGreenCRM.invoices.length}`);
  console.log(`   - Communications: ${realGreenCRM.communications.length}`);
  console.log(`\n🔌 API Endpoints:`);
  console.log(`   Core:`);
  console.log(`     - GET  /api/sites, /api/workers, /api/customers`);
  console.log(`     - POST /api/sites, /api/assign`);
  console.log(`\n   RealGreen CRM:`);
  console.log(`     - GET  /api/crm/customer/:customerId - Full customer profile`);
  console.log(`     - POST /api/crm/ticket - Create service ticket`);
  console.log(`     - POST /api/crm/invoice - Generate invoice`);
  console.log(`     - GET  /api/crm/tickets - Get all service tickets`);
  console.log(`     - GET  /api/crm/analytics/lifecycle - Customer lifecycle analytics`);
  console.log(`     - GET  /api/crm/analytics/workers - Worker performance analytics`);
  console.log(`\n   AI Agent:`);
  console.log(`     - POST /api/crm/chat - Customer service chat (CRM integrated)`);
  console.log(`     - GET  /api/ai/recommend/:siteId - AI worker recommendation`);
  console.log(`     - POST /api/ai/care-plan - Generate lawn care plan`);
  console.log(`     - POST /api/ai/batch-analyze - Batch message analysis`);
  console.log(`     - GET  /api/ai/health - Check AI agent status`);
  console.log(`\n   Knowledge Graph:`);
  console.log(`     - GET  /api/kg/query?query=... - SPARQL-style queries`);
  console.log(`     - GET  /api/kg/regional/:region - Regional expertise`);
  console.log(`     - GET  /api/kg/skills/:skill - Skill requirements`);
  console.log(`\n   Analytics:`);
  console.log(`     - GET  /api/analytics/inquiries - Customer inquiry stats`);
  console.log(`     - GET  /api/status - System status`);
  console.log(`\n🌐 WebSocket Events:`);
  console.log(`     - ai_chat - Real-time AI customer chat`);
  console.log(`     - request_recommendation - Get AI worker recommendations`);
  console.log(`     - ticket_created, invoice_created - CRM events`);
  console.log(`\n${'='.repeat(70)}\n`);
  
  if (MISTRAL_API_KEY === 'your-mistral-api-key-here') {
    console.log(`⚠️  WARNING: Set MISTRAL_API_KEY environment variable to enable AI features`);
    console.log(`   Create a .env file with: MISTRAL_API_KEY=your_actual_key\n`);
  }
  
  console.log(`✨ System ready! Visit http://localhost:${PORT} to access the dashboard\n`);
});