// Auto-summarization implementation for postgres-chat-memory.js
// Replace the placeholder createSummary method with this:

import OpenAI from 'openai';

async createSummary(sessionId) {
    logger.info(`Creating summary for session ${sessionId}`);
    
    // Get messages to summarize
    const messagesQuery = `
        SELECT id, message_type, content, created_at
        FROM chat_memory.messages
        WHERE session_id = $1
        AND created_at > COALESCE(
            (SELECT MAX(created_at) FROM chat_memory.messages 
             WHERE id = (SELECT end_message_id FROM chat_memory.summaries 
                        WHERE session_id = $1 
                        ORDER BY created_at DESC LIMIT 1)),
            '1970-01-01'::timestamp
        )
        ORDER BY created_at ASC
        LIMIT 50
    `;
    
    const messages = await postgresMemory.query(messagesQuery, [sessionId]);
    
    if (messages.rows.length < 10) {
        logger.info('Not enough messages to summarize');
        return;
    }
    
    // Format messages for summarization
    const conversation = messages.rows.map(m => 
        `${m.message_type === 'human' ? 'User' : 'Assistant'}: ${m.content}`
    ).join('\n');
    
    try {
        // Use OpenAI for summarization if available
        if (process.env.OPENAI_API_KEY) {
            const openai = new OpenAI({
                apiKey: process.env.OPENAI_API_KEY
            });
            
            const completion = await openai.chat.completions.create({
                model: "gpt-3.5-turbo",
                messages: [
                    {
                        role: "system",
                        content: "Summarize the following conversation concisely, capturing key topics, decisions, and action items. Maximum 200 words."
                    },
                    {
                        role: "user",
                        content: conversation
                    }
                ],
                max_tokens: 300,
                temperature: 0.7
            });
            
            const summary = completion.choices[0].message.content;
            
            // Store the AI-generated summary
            await this.storeSummary(sessionId, summary, messages.rows);
            
        } else {
            // Fallback: Create a basic summary without AI
            const summary = `Conversation summary (messages ${messages.rows[0].id} to ${messages.rows[messages.rows.length - 1].id}): 
            Total messages: ${messages.rows.length}
            Topics discussed: [Auto-summarization not configured - Add OPENAI_API_KEY to enable]
            Time span: ${messages.rows[0].created_at} to ${messages.rows[messages.rows.length - 1].created_at}`;
            
            await this.storeSummary(sessionId, summary, messages.rows);
        }
        
    } catch (error) {
        logger.error('Summarization failed:', error);
        // Store a basic summary on error
        const fallbackSummary = `Conversation segment with ${messages.rows.length} messages (summarization failed)`;
        await this.storeSummary(sessionId, fallbackSummary, messages.rows);
    }
}

async storeSummary(sessionId, summary, messages) {
    const insertQuery = `
        INSERT INTO chat_memory.summaries 
        (session_id, summary, message_count, start_message_id, end_message_id, tokens_used)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
    `;
    
    const tokensUsed = Math.ceil(summary.length / 4); // Rough estimate
    
    const result = await postgresMemory.query(insertQuery, [
        sessionId,
        summary,
        messages.length,
        messages[0].id,
        messages[messages.length - 1].id,
        tokensUsed
    ]);
    
    logger.info(`Summary created: ${result.rows[0].id}`);
}