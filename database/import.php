<?php
// Database import script for SecurePrint System
$servername = "localhost";
$username = "root";
$password = "";

try {
    $conn = new mysqli($servername, $username, $password);
    
    // Check connection
    if ($conn->connect_error) {
        die("Connection failed: " . $conn->connect_error);
    }
    
    // Read SQL file
    $sql = file_get_contents(__DIR__ . '/schema.sql');
    
    // Execute multiple statements
    if ($conn->multi_query($sql)) {
        echo "<h2>✓ Database schema created successfully!</h2>";
        echo "<p>The following were created:</p><ul>";
        echo "<li>Database: <strong>print_monitor</strong></li>";
        echo "<li>Tables: <strong>users</strong>, <strong>print_logs</strong></li>";
        echo "</ul>";
        echo "<p><a href='http://localhost/phpmyadmin'>Open phpMyAdmin</a> to verify</p>";
    } else {
        echo "<h2>✗ Error executing SQL:</h2>";
        echo "<pre>" . $conn->error . "</pre>";
    }
    
    $conn->close();
} catch (Exception $e) {
    echo "<h2>✗ Connection Error:</h2>";
    echo "<pre>" . $e->getMessage() . "</pre>";
}
?>
