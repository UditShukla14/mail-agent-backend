import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';

dotenv.config();

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export class AIReplyService {
  static async generateReply(context) {
    try {
      const {
        originalEmail,
        replyType = 'reply',
        userTone = 'professional',
        additionalContext = '',
        maxLength = 200,
        recipientName = '',
        senderName = ''
      } = context;

      const systemPrompt = `You are an AI assistant that helps generate email replies. You should:

1. Analyze the original email content and context
2. Generate a professional, contextual reply
3. Match the tone specified by the user (${userTone})
4. Keep the reply concise (max ${maxLength} words)
5. Be helpful, clear, and appropriate for the context
6. If it's a reply to a question, provide a direct answer
7. If it's a follow-up, acknowledge and respond appropriately
8. Use proper email etiquette
9. Use the recipient's name ('${recipientName}') in the greeting if available.
10. Use the sender's name ('${senderName}') in the signature if available.
11. DO NOT include any introductory phrases, explanations, or meta-comments. Only return the final email content, ready to send.`;

      const userPrompt = `Original Email:\nFrom: ${originalEmail.from}\nSubject: ${originalEmail.subject}\nContent: ${originalEmail.content || originalEmail.body || ''}\nTimestamp: ${originalEmail.timestamp}\n\nRecipient Name: ${recipientName}\nSender Name: ${senderName}\n\nPlease generate a ${userTone} reply for this email, using the names above.`;

      const response = await anthropic.messages.create({
        model: 'claude-3-haiku-20240307',
        max_tokens: 1000,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: userPrompt
          }
        ]
      });

      return {
        success: true,
        reply: response.content[0].text.trim(),
        usage: response.usage
      };

    } catch (error) {
      console.error('Error generating AI reply:', error);
      return {
        success: false,
        error: error.message || 'Failed to generate reply'
      };
    }
  }

  static async generateComposeEmail(context) {
    try {
      const {
        subject,
        recipient,
        purpose,
        userTone = 'professional',
        additionalContext = '',
        maxLength = 300,
        recipientName = '',
        senderName = ''
      } = context;

      const systemPrompt = `You are an AI assistant that helps compose new emails. You should:

1. Generate a professional email based on the provided context
2. Match the tone specified by the user (${userTone})
3. Keep the email concise (max ${maxLength} words)
4. Use proper email etiquette and formatting
5. Include a clear subject line if not provided
6. Be helpful, clear, and appropriate for the purpose
7. Use the recipient's name ('${recipientName}') in the greeting if available - DO NOT use placeholders like [Recipient]
8. Use the sender's name ('${senderName}') in the signature if available - DO NOT use placeholders like [Sender]
9. Make the email personal and specific to the context provided
10. DO NOT include any introductory phrases, explanations, or meta-comments. Only return the final email content, ready to send.`;

      const userPrompt = `Please compose a ${userTone} email with the following details:\n\nSubject: ${subject || 'No subject provided'}\nRecipient: ${recipient || 'No recipient specified'}\nPurpose: ${purpose || 'General communication'}\n\nRecipient Name: ${recipientName}\nSender Name: ${senderName}\n\nGenerate both a subject line (if not provided) and email body. IMPORTANT: Use the actual names provided above in the email. If recipient name is available, use it in the greeting. If sender name is available, use it in the signature. DO NOT use placeholders like [Recipient] or [Sender].`;

      const response = await anthropic.messages.create({
        model: 'claude-3-haiku-20240307',
        max_tokens: 1000,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: userPrompt
          }
        ]
      });

      const content = response.content[0].text.trim();
      
      // Try to extract subject and body if both were generated
      const lines = content.split('\n');
      let generatedSubject = subject;
      let generatedBody = content;

      if (!subject && lines.length > 0) {
        const firstLine = lines[0].trim();
        if (firstLine.startsWith('Subject:') || firstLine.startsWith('Subject line:')) {
          generatedSubject = firstLine.replace(/^Subject( line)?:\s*/i, '').trim();
          generatedBody = lines.slice(1).join('\n').trim();
        }
      }

      return {
        success: true,
        subject: generatedSubject,
        body: generatedBody,
        usage: response.usage
      };

    } catch (error) {
      console.error('Error generating compose email:', error);
      return {
        success: false,
        error: error.message || 'Failed to generate email'
      };
    }
  }

  static async improveEmail(context) {
    try {
      const {
        currentContent,
        improvementType = 'general', // 'grammar', 'tone', 'clarity', 'professional'
        userTone = 'professional',
        additionalContext = '',
        recipientName = '',
        senderName = ''
      } = context;

      const systemPrompt = `You are an AI assistant that helps improve email content. You should:

1. Improve the provided email content based on the specified improvement type
2. Maintain the original meaning and intent
3. Match the tone specified by the user (${userTone})
4. Use proper grammar, spelling, and punctuation
5. Make the content more clear and professional if requested
6. Use the recipient's name ('${recipientName}') in the greeting if available.
7. Use the sender's name ('${senderName}') in the signature if available.
8. DO NOT include any introductory phrases, explanations, or meta-comments. Only return the final email content, ready to send.

Improvement type: ${improvementType}
Additional context: ${additionalContext}`;

      const userPrompt = `Please improve the following email content:\n\n${currentContent}\n\nImprovement type: ${improvementType}\nDesired tone: ${userTone}\nRecipient Name: ${recipientName}\nSender Name: ${senderName}\n\nReturn only the improved email content, using the names above.`;

      const response = await anthropic.messages.create({
        model: 'claude-3-haiku-20240307',
        max_tokens: 1000,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: userPrompt
          }
        ]
      });

      return {
        success: true,
        improvedContent: response.content[0].text.trim(),
        usage: response.usage
      };

    } catch (error) {
      console.error('Error improving email:', error);
      return {
        success: false,
        error: error.message || 'Failed to improve email'
      };
    }
  }
} 