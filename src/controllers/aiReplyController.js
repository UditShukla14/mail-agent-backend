import { AIReplyService } from '../services/aiReplyService.js';

export const generateReply = async (req, res) => {
  try {
    const {
      originalEmail,
      replyType = 'reply',
      userTone = 'professional',
      additionalContext = '',
      maxLength = 200,
      recipientName = '',
      senderName = ''
    } = req.body;

    if (!originalEmail) {
      return res.status(400).json({
        success: false,
        error: 'Original email is required'
      });
    }

    const result = await AIReplyService.generateReply({
      originalEmail,
      replyType,
      userTone,
      additionalContext,
      maxLength,
      recipientName,
      senderName
    });

    if (result.success) {
      res.json({
        success: true,
        reply: result.reply,
        usage: result.usage
      });
    } else {
      res.status(500).json({
        success: false,
        error: result.error
      });
    }

  } catch (error) {
    console.error('Error in generateReply controller:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
};

export const generateComposeEmail = async (req, res) => {
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
    } = req.body;

    const result = await AIReplyService.generateComposeEmail({
      subject,
      recipient,
      purpose,
      userTone,
      additionalContext,
      maxLength,
      recipientName,
      senderName
    });

    if (result.success) {
      res.json({
        success: true,
        subject: result.subject,
        body: result.body,
        usage: result.usage
      });
    } else {
      res.status(500).json({
        success: false,
        error: result.error
      });
    }

  } catch (error) {
    console.error('Error in generateComposeEmail controller:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
};

export const improveEmail = async (req, res) => {
  try {
    const {
      currentContent,
      improvementType = 'general',
      userTone = 'professional',
      additionalContext = '',
      recipientName = '',
      senderName = ''
    } = req.body;

    if (!currentContent) {
      return res.status(400).json({
        success: false,
        error: 'Current content is required'
      });
    }

    const result = await AIReplyService.improveEmail({
      currentContent,
      improvementType,
      userTone,
      additionalContext,
      recipientName,
      senderName
    });

    if (result.success) {
      res.json({
        success: true,
        improvedContent: result.improvedContent,
        usage: result.usage
      });
    } else {
      res.status(500).json({
        success: false,
        error: result.error
      });
    }

  } catch (error) {
    console.error('Error in improveEmail controller:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
}; 