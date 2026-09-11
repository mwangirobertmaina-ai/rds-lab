import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';

void main() {
  runApp(const RDSApp());
}

class RDSApp extends StatelessWidget {
  const RDSApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'RDS Management Terminal',
      debugShowCheckedModeBanner: false,
      theme: ThemeData.dark().copyWith(
        scaffoldBackgroundColor: const Color(0xFF000000),
        primaryColor: const Color(0xFF00FF88),
      ),
      home: const RDSDashboard(),
    );
  }
}

class RDSDashboard extends StatefulWidget {
  const RDSDashboard({super.key});

  @override
  State<RDSDashboard> createState() => _RDSDashboardState();
}

class _RDSDashboardState extends State<RDSDashboard> {
  final String apiBase = "https://rds-lab.onrender.com";
  bool isLoading = true;
  Map<String, dynamic> stats = {};

  @override
  void initState() {
    super.initState();
    fetchSystemStats();
  }

  Future<void> fetchSystemStats() async {
    try {
      final response = await http.get(Uri.parse('$apiBase/system/stats'));
      if (response.statusCode == 200) {
        final data = json.decode(response.body);
        setState(() {
          stats = data['stats'] ?? {};
          isLoading = false;
        });
      }
    } catch (e) {
      setState(() {
        isLoading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Row(
          children: const [
            Icon(Icons.settings, color: Color(0xFF00FF88)),
            SizedBox(width: 8),
            Text('RDS FLEET MANAGEMENT'),
          ],
        ),
        backgroundColor: const Color(0xFF111111),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh, color: Color(0xFF00FF88)),
            onPressed: () {
              setState(() => isLoading = true);
              fetchSystemStats();
            },
          )
        ],
      ),
      body: isLoading
          ? const Center(child: CircularProgressIndicator(color: Color(0xFF00FF88)))
          : Padding(
              padding: const EdgeInsets.all(16.0),
              child: GridView.count(
                crossAxisCount: 2,
                crossAxisSpacing: 10,
                mainAxisSpacing: 10,
                children: [
                  _buildStatCard("GROSS VOLUME", "\$${(stats['grossVolume'] ?? 0).toString()}"),
                  _buildStatCard("ACTIVE DRIVERS", "${stats['activeDrivers'] ?? 0}"),
                  _buildStatCard("ORDERS", "${stats['orders'] ?? 0}"),
                  _buildStatCard("MERCHANTS", "${stats['businesses'] ?? 0}"),
                ],
              ),
            ),
    );
  }

  Widget _buildStatCard(String title, String value) {
    return Container(
      decoration: BoxDecoration(
        color: const Color(0xFF181818),
        border: Border.all(color: const Color(0xFF00FF88), width: 1),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Text(title, style: const TextStyle(color: Colors.grey, fontSize: 12)),
          const SizedBox(height: 8),
          Text(value, style: const TextStyle(color: Color(0xFFFFD700), fontSize: 24, fontWeight: FontWeight.bold)),
        ],
      ),
    );
  }
}