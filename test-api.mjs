import fetch from 'node-fetch';

async function test() {
    const payload = {
        query: "Hello, how can you help me?",
        user_key: "test_user_123",
        tenant_id: 4
    };

    try {
        console.log('Sending request to /chat...');
        const res = await fetch('http://localhost:4000/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await res.json();
        console.log('Response Status:', res.status);
        console.log('Response Body:', JSON.stringify(data, null, 2));
    } catch (err) {
        console.error('Test failed:');
        console.error(err);
    }
}

test();
