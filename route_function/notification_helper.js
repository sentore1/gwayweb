const { DataFind, DataInsert } = require("../middleware/databse_query");
const sendOneNotification = require("../middleware/send");

const sendTemplatedNotification = async (key, targetType, targetUserId, placeholders = {}) => {
    try {
        const templates = await DataFind(`SELECT * FROM tbl_notification_templates WHERE key_name = '${key}'`);
        if (templates.length === 0) {
            console.error(`Notification template not found for key: ${key}`);
            return;
        }

        let title = templates[0].title;
        let message = templates[0].message;

        // Replace placeholder tags (e.g. {otp} with placeholders.otp)
        for (const [placeholder, value] of Object.entries(placeholders)) {
            const regex = new RegExp(`{${placeholder}}`, 'g');
            const sanitizedValue = (value !== undefined && value !== null) ? value : '';
            title = title.replace(regex, sanitizedValue);
            message = message.replace(regex, sanitizedValue);
        }

        // Save to in-app notification database table
        const dateNow = new Date().toISOString().slice(0, 19).replace('T', ' ');
        const escTitle = title.replace(/'/g, "''");
        const escMessage = message.replace(/'/g, "''");

        if (targetType === 'driver') {
            await DataInsert('tbl_send_notification', `driver, customer, title, description, date`, `'${targetUserId}', '0', '${escTitle}', '${escMessage}', '${dateNow}'`);
        } else if (targetType === 'customer') {
            await DataInsert('tbl_send_notification', `driver, customer, title, description, date`, `'0', '${targetUserId}', '${escTitle}', '${escMessage}', '${dateNow}'`);
        }

        await sendOneNotification(message, targetType, targetUserId, {
            title: title,
            description: message
        });
        console.log(`Templated notification [${key}] sent successfully to ${targetType} (ID: ${targetUserId})`);
    } catch (error) {
        console.error(`Error sending templated notification [${key}]:`, error);
    }
};

module.exports = { sendTemplatedNotification };

