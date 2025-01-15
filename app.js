require("dotenv").config();
const express = require("express");
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");
const morgan = require("morgan");
const { Client } = require("ssh2");
const cron = require("node-cron");
const { PassThrough } = require("stream");
const fs = require("fs");
const path = require("path");
const app = express();
const port = 3000;

// List of required environment variables
const requiredEnvVars = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_REGION",
  "S3_BUCKET_NAME",
  "DB_HOST",
  "DB_USER",
  "DB_PASSWORD",
  "DB_NAME",
  "SSH_HOST",
  "SSH_USER",
  "SSH_PASSWORD",
  "RETENTION_DAYS",
  "CRON_SCHEDULE",
];

// Check for missing environment variables
const missingEnvVars = requiredEnvVars.filter((envVar) => !process.env[envVar]);

// Middleware
app.use(express.json());
app.use(morgan("combined")); // Logging

// Serve static files (index.html)
app.use(express.static(path.join(__dirname, "public")));

// Retention policy configuration
let retentionDays = parseInt(process.env.RETENTION_DAYS) || 30; // Default retention period in days
let cronSchedule = process.env.CRON_SCHEDULE || "0 2 * * *"; // Default schedule: 2 AM daily

// Function to read .env file
function readEnvFile() {
  try {
    const envPath = path.join(__dirname, ".env");
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, "utf8");
      const envVars = {};
      envContent.split("\n").forEach((line) => {
        const [key, value] = line.split("=");
        if (key && value) {
          envVars[key.trim()] = value.trim();
        }
      });
      return envVars;
    }
    return {};
  } catch (error) {
    console.error("Error reading .env file:", error);
    return {};
  }
}

// Updated env-check endpoint
app.get("/env-check", (req, res) => {
  const currentEnvVars = readEnvFile();
  const missing = requiredEnvVars.filter((envVar) => !currentEnvVars[envVar]);

  if (missing.length > 0) {
    res.status(400).json({
      success: false,
      message: "Missing required environment variables",
      missing,
      currentEnvVars: {}, // Don't send sensitive data if not properly configured
    });
  } else {
    res.status(200).json({
      success: true,
      message: "All environment variables are set",
      currentEnvVars: currentEnvVars, // This includes sensitive data
    });
  }
});

// Updated save-env endpoint
app.post("/save-env", (req, res) => {
  const envVars = req.body;

  // Validate required fields
  const missingFields = requiredEnvVars.filter((field) => !envVars[field]);

  if (missingFields.length > 0) {
    return res.status(400).json({
      success: false,
      message: "Missing required fields",
      missing: missingFields,
    });
  }

  // Create the .env file content
  const envContent = Object.entries(envVars)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  try {
    // Write to the .env file
    fs.writeFileSync(path.join(__dirname, ".env"), envContent);

    // Reload environment variables
    require("dotenv").config();

    res.status(200).json({
      success: true,
      message: "Environment variables saved successfully",
    });
  } catch (error) {
    console.error("Error saving .env file:", error);
    res.status(500).json({
      success: false,
      message: "Failed to save environment variables",
    });
  }
});

// Configure AWS S3 client (only if all environment variables are set)
let s3Client;
if (missingEnvVars.length === 0) {
  s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });
}

// Backup function (extracted from the /backup endpoint)
const performBackup = async () => {
  if (missingEnvVars.length > 0) {
    console.error(
      "Cannot perform backup: Missing required environment variables"
    );
    return;
  }

  let backupFilePath = `./backup_${Date.now()}.sql.gz`;
  let fileStream = fs.createWriteStream(backupFilePath);

  try {
    const conn = new Client();

    // Connect to the remote server via SSH
    conn.on("ready", () => {
      console.log("SSH connection established.");

      // Run mysqldump on the remote server and stream the output
      conn.exec(
        `mysqldump -h ${process.env.DB_HOST} -u ${process.env.DB_USER} -p${process.env.DB_PASSWORD} ${process.env.DB_NAME} | gzip`,
        (err, stream) => {
          if (err) {
            console.error("Failed to execute mysqldump:", err);
            conn.end();
            return;
          }

          // Stream the output to a local file
          stream.pipe(fileStream);

          stream.on("close", () => {
            console.log("Backup file created:", backupFilePath);
            conn.end();

            // Upload the backup file to S3 using streams
            const passThrough = new PassThrough();
            fs.createReadStream(backupFilePath).pipe(passThrough);

            const uploadParams = {
              Bucket: process.env.S3_BUCKET_NAME,
              Key: `backups/${backupFilePath.split("/").pop()}`,
              Body: passThrough,
            };

            s3Client
              .send(new PutObjectCommand(uploadParams))
              .then((data) => {
                console.log("Backup uploaded to S3:", data.Key);
              })
              .catch((err) => {
                console.error("S3 upload error:", err);
              });
          });

          stream.on("error", (err) => {
            console.error("Stream error:", err);
            conn.end();
          });
        }
      );
    });

    conn.on("error", (err) => {
      console.error("SSH connection error:", err);
    });

    conn.connect({
      host: process.env.SSH_HOST,
      port: 22,
      username: process.env.SSH_USER,
      password: process.env.SSH_PASSWORD,
    });
  } catch (error) {
    console.error("Backup error:", error);
  } finally {
    // Ensure the file is deleted after upload or on error
    fileStream.close(() => {
      fs.unlink(backupFilePath, (err) => {
        if (err) console.error("Error deleting backup file:", err);
        else console.log("Backup file deleted:", backupFilePath);
      });
    });
  }
};

// Backup endpoint with SSH2 (only if all environment variables are set)
app.post("/backup", async (req, res) => {
  if (missingEnvVars.length > 0) {
    return res
      .status(400)
      .json({ error: "Missing required environment variables" });
  }

  try {
    await performBackup();
    res.status(200).json({ message: "Backup successful" });
  } catch (error) {
    console.error("Backup error:", error);
    res.status(500).json({ error: "Backup failed" });
  }
});

// Restore endpoint (only if all environment variables are set)
app.post("/restore/:key", async (req, res) => {
  if (missingEnvVars.length > 0) {
    return res
      .status(400)
      .json({ error: "Missing required environment variables" });
  }

  const { key } = req.params;
  let restoreFilePath = `./restore_${Date.now()}.sql.gz`;

  try {
    // Download the backup file from S3
    const getObjectParams = {
      Bucket: process.env.S3_BUCKET_NAME,
      Key: key,
    };

    const { Body: s3Stream } = await s3Client.send(
      new GetObjectCommand(getObjectParams)
    );
    const fileStream = fs.createWriteStream(restoreFilePath);
    s3Stream.pipe(fileStream);

    fileStream.on("finish", () => {
      console.log("Backup file downloaded:", restoreFilePath);

      // Run mysql command to restore the database
      const mysqlCommand = `gunzip < ${restoreFilePath} | mysql -h ${process.env.DB_HOST} -u ${process.env.DB_USER} -p${process.env.DB_PASSWORD} ${process.env.DB_NAME}`;
      exec(mysqlCommand, (error, stdout, stderr) => {
        if (error) {
          console.error("Restore error:", error);
          res.status(500).json({ error: "Restore failed" });
          return;
        }

        res.status(200).json({ message: "Restore successful" });
      });
    });

    fileStream.on("error", (err) => {
      console.error("File stream error:", err);
      res.status(500).json({ error: "Failed to download backup file" });
    });
  } catch (error) {
    console.error("Restore error:", error);
    res.status(500).json({ error: "Restore failed" });
  } finally {
    // Ensure the file is deleted after restore or on error
    fs.unlink(restoreFilePath, (err) => {
      if (err) console.error("Error deleting restore file:", err);
      else console.log("Restore file deleted:", restoreFilePath);
    });
  }
});

// List backups endpoint (only if all environment variables are set)
app.get("/backups", async (req, res) => {
  if (missingEnvVars.length > 0) {
    return res
      .status(400)
      .json({ error: "Missing required environment variables" });
  }

  try {
    const listObjectsParams = {
      Bucket: process.env.S3_BUCKET_NAME,
      Prefix: "backups/",
    };

    const data = await s3Client.send(
      new ListObjectsV2Command(listObjectsParams)
    );

    const backups = data.Contents.map((item) => ({
      key: item.Key,
      size: item.Size,
      lastModified: item.LastModified,
    }));

    res.status(200).json(backups);
  } catch (error) {
    console.error("List backups error:", error);
    res.status(500).json({ error: "Failed to list backups" });
  }
});

// Delete backup endpoint (only if all environment variables are set)
app.delete("/backups/:key", async (req, res) => {
  if (missingEnvVars.length > 0) {
    return res
      .status(400)
      .json({ error: "Missing required environment variables" });
  }

  try {
    const { key } = req.params;

    const deleteObjectParams = {
      Bucket: process.env.S3_BUCKET_NAME,
      Key: key,
    };

    await s3Client.send(new DeleteObjectCommand(deleteObjectParams));
    res.status(200).json({ message: "Backup deleted successfully" });
  } catch (error) {
    console.error("Delete backup error:", error);
    res.status(500).json({ error: "Failed to delete backup" });
  }
});

// Retention policy: Delete backups older than retentionDays (configurable)
const deleteOldBackups = async () => {
  if (missingEnvVars.length > 0) {
    console.error(
      "Cannot run retention policy: Missing required environment variables"
    );
    return;
  }

  try {
    const listObjectsParams = {
      Bucket: process.env.S3_BUCKET_NAME,
      Prefix: "backups/",
    };

    const data = await s3Client.send(
      new ListObjectsV2Command(listObjectsParams)
    );

    const now = Date.now();
    const retentionTime = now - retentionDays * 24 * 60 * 60 * 1000; // retentionDays in milliseconds

    for (const item of data.Contents) {
      if (item.LastModified < new Date(retentionTime)) {
        const deleteObjectParams = {
          Bucket: process.env.S3_BUCKET_NAME,
          Key: item.Key,
        };

        await s3Client.send(new DeleteObjectCommand(deleteObjectParams));
        console.log(`Deleted old backup: ${item.Key}`);
      } else {
        console.log(`Backup is within retention period: ${item.Key}`);
      }
    }
  } catch (error) {
    console.error("Error deleting old backups:", error);
  }
};

// Schedule retention policy cleanup daily at 3 AM (only if all environment variables are set)
if (missingEnvVars.length === 0) {
  cron.schedule("0 3 * * *", async () => {
    try {
      console.log("Running retention policy cleanup...");
      await deleteOldBackups();
      console.log("Retention policy cleanup completed.");
    } catch (error) {
      console.error("Retention policy cleanup failed:", error);
    }
  });
}

// Endpoint to save the retention policy
app.post("/delete-policy", async (req, res) => {
  try {
    const { days } = req.body;

    // Validate the input
    if (isNaN(days) || days < 1) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid retention days. Please provide a number greater than 0.",
      });
    }

    // Update the retentionDays variable
    retentionDays = days;

    // Update the .env file
    const envPath = path.join(__dirname, ".env");
    let envContent = fs.existsSync(envPath)
      ? fs.readFileSync(envPath, "utf8")
      : "";
    const envVars = envContent.split("\n").filter((line) => line.trim() !== "");
    const retentionIndex = envVars.findIndex((line) =>
      line.startsWith("RETENTION_DAYS=")
    );

    if (retentionIndex !== -1) {
      envVars[retentionIndex] = `RETENTION_DAYS=${days}`;
    } else {
      envVars.push(`RETENTION_DAYS=${days}`);
    }

    fs.writeFileSync(envPath, envVars.join("\n"));

    // Return success response
    res.status(200).json({
      success: true,
      message: "Retention policy saved successfully",
    });
  } catch (error) {
    console.error("Error saving retention policy:", error);
    res.status(500).json({
      success: false,
      message: "Failed to save retention policy",
    });
  }
});

// Function to reschedule the cron job
const rescheduleCronJob = (newSchedule) => {
  if (cron.validate(newSchedule)) {
    // Stop the existing cron job (if any)
    cron.getTasks().forEach((task) => task.stop());

    // Schedule the backup task with the new schedule
    cron.schedule(newSchedule, async () => {
      try {
        console.log("Running scheduled backup...");
        await performBackup(); // Call the backup function
        console.log("Scheduled backup completed.");
      } catch (error) {
        console.error("Scheduled backup failed:", error);
      }
    });

    console.log("Cron job rescheduled with new schedule:", newSchedule);
  } else {
    console.error("Invalid cron schedule:", newSchedule);
  }
};

// Initial cron job setup
if (missingEnvVars.length === 0) {
  rescheduleCronJob(cronSchedule);
}

// Endpoint to save the cron schedule
app.post("/cron", async (req, res) => {
  try {
    const { schedule } = req.body;

    // Validate the cron schedule
    if (!cron.validate(schedule)) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid cron schedule. Please provide a valid cron expression.",
      });
    }

    // Update the cron schedule
    cronSchedule = schedule;

    // Update the .env file
    const envPath = path.join(__dirname, ".env");
    let envContent = fs.existsSync(envPath)
      ? fs.readFileSync(envPath, "utf8")
      : "";
    const envVars = envContent.split("\n").filter((line) => line.trim() !== "");
    const cronIndex = envVars.findIndex((line) =>
      line.startsWith("CRON_SCHEDULE=")
    );

    if (cronIndex !== -1) {
      envVars[cronIndex] = `CRON_SCHEDULE=${schedule}`;
    } else {
      envVars.push(`CRON_SCHEDULE=${schedule}`);
    }

    fs.writeFileSync(envPath, envVars.join("\n"));

    // Reschedule the cron job with the new schedule
    rescheduleCronJob(schedule);

    // Return success response
    res.status(200).json({
      success: true,
      message: "Cron schedule saved and updated successfully",
    });
  } catch (error) {
    console.error("Error saving cron schedule:", error);
    res.status(500).json({
      success: false,
      message: "Failed to save cron schedule",
    });
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
