```javascript
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cron = require('node-cron');
const bodyParser = require('body-parser');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// In-memory database (voor productie: gebruik PostgreSQL of MongoDB)
let pendingPayments = [];
let caregivers = [];

// Root endpoint
app.get('/', (req, res) => {
    res.json({ 
        message: 'SeniorQuick Thuiszorg API',
        version: '1.0.0',
        status: 'active'
    });
});

// Webhook voor aanmelding zorgmedewerkers
app.post('/aanmelding-webhook', async (req, res) => {
    try {
        console.log('Aanmelding webhook ontvangen:', req.body);
        
        const { fullName, email, submissionId } = req.body;
        
        if (!fullName || !email) {
            return res.status(400).json({ error: 'Naam en email zijn verplicht' });
        }
        
        // Maak Stripe Express account
        const account = await stripe.accounts.create({
            type: 'express',
            country: 'NL',
            email: email,
            capabilities: {
                card_payments: { requested: true },
                transfers: { requested: true }
            },
            settings: {
                payouts: {
                    schedule: { interval: 'manual' }
                }
            }
        });
        
        // Sla zorgmedewerker op
        const caregiver = {
            id: account.id,
            name: fullName,
            email: email,
            submissionId: submissionId,
            stripeAccountId: account.id,
            createdAt: new Date()
        };
        
        caregivers.push(caregiver);
        
        // Maak account link voor onboarding
        const accountLink = await stripe.accountLinks.create({
            account: account.id,
            refresh_url: `${req.protocol}://${req.get('host')}/reauth`,
            return_url: `${req.protocol}://${req.get('host')}/return`,
            type: 'account_onboarding'
        });
        
        console.log(`Zorgmedewerker ${fullName} aangemeld met account ${account.id}`);
        
        res.json({ 
            success: true, 
            accountId: account.id,
            accountLink: accountLink.url 
        });
        
    } catch (error) {
        console.error('Fout bij aanmelding:', error);
        res.status(500).json({ error: error.message });
    }
});

// Webhook voor boekingen
app.post('/boekings-webhook', async (req, res) => {
    try {
        console.log('Boekings webhook ontvangen:', req.body);
        
        const { 
            fullName, 
            email, 
            phoneNumber, 
            formCalculation, 
            zorgmedewerkerId, 
            submissionId 
        } = req.body;
        
        if (!fullName || !email || !phoneNumber || !formCalculation || !zorgmedewerkerId) {
            return res.status(400).json({ error: 'Verplichte velden ontbreken' });
        }
        
        // Zoek zorgmedewerker
        const caregiver = caregivers.find(c => c.stripeAccountId === zorgmedewerkerId);
        if (!caregiver) {
            console.log('Beschikbare zorgmedewerkers:', caregivers.map(c => c.stripeAccountId));
            return res.status(404).json({ error: 'Zorgmedewerker niet gevonden' });
        }
        
        // Bereken bedragen
        const totalAmount = Math.round(parseFloat(formCalculation) * 100); // Stripe gebruikt centen
        const caregiverAmount = Math.round(totalAmount * 0.35);
        const platformAmount = totalAmount - caregiverAmount;
        
        // Sla betaling op voor 48-uur check
        const payment = {
            id: submissionId || `payment_${Date.now()}`,
            customerName: fullName,
            customerEmail: email,
            customerPhone: phoneNumber,
            caregiverId: zorgmedewerkerId,
            caregiverName: caregiver.name,
            totalAmount: totalAmount,
            caregiverAmount: caregiverAmount,
            platformAmount: platformAmount,
            createdAt: new Date(),
            status: 'pending'
        };
        
        pendingPayments.push(payment);
        
        // Plan automatische uitbetaling na 48 uur (in productie)
        // Voor demo: 2 minuten
        const checkDelay = process.env.NODE_ENV === 'production' ? 
            48 * 60 * 60 * 1000 : // 48 uur
            2 * 60 * 1000; // 2 minuten voor demo
            
        setTimeout(() => {
            processAutomaticPayout(payment);
        }, checkDelay);
        
        console.log(`Boeking ${payment.id} ontvangen voor zorgmedewerker ${caregiver.name}`);
        console.log(`Totaal: €${totalAmount/100}, Zorgmedewerker: €${caregiverAmount/100}, Platform: €${platformAmount/100}`);
        
        res.json({ 
            success: true, 
            paymentId: payment.id,
            caregiverName: caregiver.name,
            totalAmount: totalAmount/100
        });
        
    } catch (error) {
        console.error('Fout bij boeking:', error);
        res.status(500).json({ error: error.message });
    }
});

// Automatische uitbetaling na 48 uur
async function processAutomaticPayout(payment) {
    try {
        // Controleer of betaling nog pending is
        const currentPayment = pendingPayments.find(p => p.id === payment.id);
        if (!currentPayment || currentPayment.status !== 'pending') {
            console.log(`Betaling ${payment.id} al verwerkt of niet gevonden`);
            return;
        }
        
        // Verwerk uitbetaling automatisch na 48 uur
        await processPayment(currentPayment);
        currentPayment.status = 'completed';
        
        console.log(`Automatische uitbetaling verwerkt voor boeking ${payment.id} na 48 uur`);
        
    } catch (error) {
        console.error('Fout bij automatische uitbetaling:', error);
        const currentPayment = pendingPayments.find(p => p.id === payment.id);
        if (currentPayment) {
            currentPayment.status = 'failed';
            currentPayment.error = error.message;
        }
    }
}

// Uitbetaling verwerken
async function processPayment(payment) {
    try {
        // Transfer naar zorgmedewerker
        const transfer = await stripe.transfers.create({
            amount: payment.caregiverAmount,
            currency: 'eur',
            destination: payment.caregiverId,
            transfer_group: payment.id,
            description: `Uitbetaling voor ${payment.customerName} - ${payment.id}`
        });
        
        console.log(`Uitbetaling van €${payment.caregiverAmount/100} verwerkt voor boeking ${payment.id}`);
        console.log(`Transfer ID: ${transfer.id}`);
        
        payment.transferId = transfer.id;
        payment.transferDate = new Date();
        
    } catch (error) {
        console.error('Fout bij uitbetaling:', error);
        payment.status = 'failed';
        payment.error = error.message;
        throw error;
    }
}

// Automatische cleanup van oude betalingen
cron.schedule('0 2 * * *', () => {
    const now = new Date();
    const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); // 30 dagen geleden
    
    const oldCount = pendingPayments.length;
    pendingPayments = pendingPayments.filter(p => 
        new Date(p.createdAt) > cutoff
    );
    
    console.log(`Cleanup: ${oldCount - pendingPayments.length} oude betalingen verwijderd`);
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        pendingPayments: pendingPayments.length,
        caregivers: caregivers.length,
        environment: process.env.NODE_ENV || 'development'
    });
});

// Dashboard endpoint (voor monitoring)
app.get('/dashboard', (req, res) => {
    const completedPayments = pendingPayments.filter(p => p.status === 'completed');
    const failedPayments = pendingPayments.filter(p => p.status === 'failed');
    const totalRevenue = completedPayments.reduce((sum, p) => sum + p.platformAmount, 0);
    
    res.json({
        summary: {
            totalCaregivers: caregivers.length,
            pendingPayments: pendingPayments.filter(p => p.status === 'pending').length,
            completedPayments: completedPayments.length,
            failedPayments: failedPayments.length,
            totalRevenue: totalRevenue / 100 // Convert to euros
        },
        recentPayments: pendingPayments.slice(-10).map(p => ({
            id: p.id,
            customer: p.customerName,
            caregiver: p.caregiverName,
            amount: p.totalAmount / 100,
            status: p.status,
            createdAt: p.createdAt
        }))
    });
});

// Stripe account return URL
app.get('/return', (req, res) => {
    res.send(`
        <html>
            <body>
                <h1>Account setup voltooid!</h1>
                <p>Je Stripe Express-account is succesvol ingesteld. Je kunt nu betalingen ontvangen via SeniorQuick.</p>
                <p>Je kunt dit venster sluiten.</p>
            </body>
        </html>
    `);
});

// Stripe account refresh URL
app.get('/reauth', (req, res) => {
    res.send(`
        <html>
            <body>
                <h1>Account setup vereist</h1>
                <p>Er is aanvullende informatie nodig om je account te voltooien. Neem contact op met support.</p>
            </body>
        </html>
    `);
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Onverwachte fout:', error);
    res.status(500).json({ 
        error: 'Er is een onverwachte fout opgetreden',
        timestamp: new Date().toISOString()
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ 
        error: 'Endpoint niet gevonden',
        path: req.path,
        method: req.method
    });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`SeniorQuick server draait op poort ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`Stripe configuratie: ${process.env.STRIPE_SECRET_KEY ? 'OK' : 'ONTBREEKT'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM ontvangen, server wordt afgesloten...');
    process.exit(0);
});

module.exports = app;
```
